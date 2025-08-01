/* global waitForWebfonts */

import { Mutex } from "@web/core/utils/concurrency";
import { markRaw } from "@odoo/owl";
import { floatIsZero } from "@web/core/utils/numbers";
import { renderToElement } from "@web/core/utils/render";
import { registry } from "@web/core/registry";
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import {
    deduceUrl,
    lte,
    random5Chars,
    uuidv4,
    computeProductPricelistCache,
} from "@point_of_sale/utils";
import { Reactive } from "@web/core/utils/reactive";
import { HWPrinter } from "@point_of_sale/app/printer/hw_printer";
import { ConnectionLostError } from "@web/core/network/rpc";
import { OrderReceipt } from "@point_of_sale/app/screens/receipt_screen/receipt/order_receipt";
import { _t } from "@web/core/l10n/translation";
import { OpeningControlPopup } from "@point_of_sale/app/store/opening_control_popup/opening_control_popup";
import { ProductScreen } from "@point_of_sale/app/screens/product_screen/product_screen";
import { TicketScreen } from "@point_of_sale/app/screens/ticket_screen/ticket_screen";
import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { EditListPopup } from "@point_of_sale/app/store/select_lot_popup/select_lot_popup";
import { ProductConfiguratorPopup } from "./product_configurator_popup/product_configurator_popup";
import { ComboConfiguratorPopup } from "./combo_configurator_popup/combo_configurator_popup";
import {
    makeAwaitable,
    ask,
    makeActionAwaitable,
} from "@point_of_sale/app/store/make_awaitable_dialog";
import { PartnerList } from "../screens/partner_list/partner_list";
import { ScaleScreen } from "../screens/scale_screen/scale_screen";
import { computeComboItems } from "../models/utils/compute_combo_items";
import { changesToOrder, getOrderChanges } from "../models/utils/order_change";
import { getTaxesAfterFiscalPosition } from "../models/utils/tax_utils";
import { accountTaxHelpers } from "@account/helpers/account_tax";
import { QRPopup } from "@point_of_sale/app/utils/qr_code_popup/qr_code_popup";
import { ActionScreen } from "@point_of_sale/app/screens/action_screen";
import { FormViewDialog } from "@web/views/view_dialogs/form_view_dialog";
import { CashMovePopup } from "@point_of_sale/app/navbar/cash_move_popup/cash_move_popup";
import { ClosePosPopup } from "../navbar/closing_popup/closing_popup";
import { user } from "@web/core/user";
import { debounce } from "@web/core/utils/timing";
import DevicesSynchronisation from "./devices_synchronisation";
import { openCustomerDisplay } from "@point_of_sale/customer_display/utils";

const { DateTime } = luxon;

export class PosStore extends Reactive {
    loadingSkipButtonIsShown = false;
    mainScreen = { name: null, component: null };

    static serviceDependencies = [
        "bus_service",
        "number_buffer",
        "barcode_reader",
        "hardware_proxy",
        "ui",
        "pos_data",
        "pos_scale",
        "dialog",
        "notification",
        "printer",
        "action",
        "alert",
        "mail.sound_effects",
    ];
    constructor() {
        super();
        this.ready = this.setup(...arguments).then(() => this);
    }
    // use setup instead of constructor because setup can be patched.
    async setup(
        env,
        {
            number_buffer,
            hardware_proxy,
            barcode_reader,
            ui,
            dialog,
            notification,
            printer,
            bus_service,
            pos_data,
            pos_scale,
            action,
            alert,
        }
    ) {
        this.env = env;
        this.numberBuffer = number_buffer;
        this.barcodeReader = barcode_reader;
        this.ui = ui;
        this.dialog = dialog;
        this.printer = printer;
        this.bus = bus_service;
        this.data = pos_data;
        this.action = action;
        this.alert = alert;
        this.sound = env.services["mail.sound_effects"];
        this.notification = notification;
        this.unwatched = markRaw({});
        this.pushOrderMutex = new Mutex();

        // Business data; loaded from the server at launch
        this.company_logo = null;
        this.company_logo_base64 = "";
        this.order_sequence = 1;
        this.printers_category_ids_set = new Set();

        // Object mapping the order's name (which contains the uuid) to it's server_id after
        // validation (order paid then sent to the backend).
        this.validated_orders_name_server_id_map = {};
        this.numpadMode = "quantity";
        this.mobile_pane = "right";
        this.ticket_screen_mobile_pane = "left";
        this.productListView = window.localStorage.getItem("productListView") || "grid";

        this.ticketScreenState = {
            offsetByDomain: {},
            totalCount: 0,
        };

        this.loadingOrderState = false; // used to prevent orders fetched to be put in the update set during the reactive change

        // Handle offline mode
        // All of Set of ids
        this.pendingOrder = {
            write: new Set(),
            delete: new Set(),
            create: new Set(),
        };

        this.hardwareProxy = hardware_proxy;
        this.hiddenProductIds = new Set();
        this.selectedOrderUuid = null;
        this.selectedPartner = null;
        this.selectedCategory = null;
        this.searchProductWord = "";
        this.mainProductVariant = {};
        this.ready = new Promise((resolve) => {
            this.markReady = resolve;
        });
        this.scale = pos_scale;

        // FIXME POSREF: the hardwareProxy needs the pos and the pos needs the hardwareProxy. Maybe
        // the hardware proxy should just be part of the pos service?
        this.hardwareProxy.pos = this;
        this.syncingOrders = new Set();
        await this.initServerData();
        if (this.useProxy()) {
            await this.connectToProxy();
        }
        this.closeOtherTabs();
        this.syncAllOrdersDebounced = debounce(this.syncAllOrders, 100);

        window.addEventListener("online", () => {
            // Sync should be done before websocket connection when going online
            this.syncAllOrdersDebounced();
        });
    }

    get firstScreen() {
        if (odoo.from_backend) {
            // Remove from_backend params in the URL but keep the rest
            const url = new URL(window.location.href);
            url.searchParams.delete("from_backend");
            window.history.replaceState({}, "", url);

            if (!this.config.module_pos_hr) {
                this.set_cashier(this.user);
            }
        }

        return !this.cashier ? "LoginScreen" : "ProductScreen";
    }

    get idleTimeout() {
        return [
            {
                timeout: 300000, // 5 minutes
                action: () =>
                    this.mainScreen.component.name !== "PaymentScreen" &&
                    this.showScreen("SaverScreen"),
            },
            {
                timeout: 120000, // 2 minutes
                action: () =>
                    this.mainScreen.component.name === "LoginScreen" &&
                    this.showScreen("SaverScreen"),
            },
        ];
    }

    async showLoginScreen() {
        this.reset_cashier();
        this.showScreen("LoginScreen");
        this.dialog.closeAll();
    }

    reset_cashier() {
        this.cashier = false;
        this._resetConnectedCashier();
    }

    checkPreviousLoggedCashier() {
        const savedCashier = this._getConnectedCashier();
        if (savedCashier) {
            this.set_cashier(savedCashier);
        }
    }

    set_cashier(user) {
        if (!user) {
            return;
        }

        this.cashier = user;
        this._storeConnectedCashier(user);
    }

    _getConnectedCashier() {
        const cashier_id = Number(sessionStorage.getItem(`connected_cashier_${this.config.id}`));
        if (cashier_id && this.models["res.users"].get(cashier_id)) {
            return this.models["res.users"].get(cashier_id);
        }
        return false;
    }

    _storeConnectedCashier(user) {
        sessionStorage.setItem(`connected_cashier_${this.config.id}`, user.id);
    }

    _resetConnectedCashier() {
        sessionStorage.removeItem(`connected_cashier_${this.config.id}`);
    }

    useProxy() {
        return (
            this.config.is_posbox &&
            (this.config.iface_electronic_scale ||
                this.config.iface_print_via_proxy ||
                this.config.iface_scan_via_proxy ||
                this.config.iface_customer_facing_display_via_proxy)
        );
    }

    async initServerData() {
        await this.processServerData();
        this.data.connectWebSocket("CLOSING_SESSION", this.closingSessionNotification.bind(this));
        return await this.afterProcessServerData();
    }

    async closingSessionNotification(data) {
        if (data.login_number == odoo.login_number) {
            return;
        }

        try {
            const paidOrderNotSynced = this.models["pos.order"].filter(
                (order) => order.state === "paid" && order.id !== "number"
            );
            this.addPendingOrder(paidOrderNotSynced.map((o) => o.id));
            await this.syncAllOrders({ throw: true });

            this.dialog.add(AlertDialog, {
                title: _t("Closing Session"),
                body: _t("The session is being closed by another user. The page will be reloaded."),
            });
        } catch {
            this.dialog.add(AlertDialog, {
                title: _t("Error"),
                body: _t(
                    "An error occurred while closing the session. Unsynced orders will be available in the next session. The page will be reloaded."
                ),
            });
        } finally {
            // All orders saved on the server should be cancelled by the device that closes
            // the session. If some orders are not cancelled, we need to cancel them here.
            const orders = this.models["pos.order"].filter((o) => typeof o.id === "number");
            for (const order of orders) {
                if (!order.finalized) {
                    order.state = "cancel";
                }
            }
        }

        setTimeout(() => {
            window.location.reload();
        }, 3000);
    }

    get session() {
        return this.data.models["pos.session"].getFirst();
    }

    async processServerData() {
        // These fields should be unique for the pos_config
        // and should not change during the session, so we can
        // safely take the first element.this.models
        this.config = this.data.models["pos.config"].getFirst();
        this.company = this.data.models["res.company"].getFirst();
        this.user = this.data.models["res.users"].getFirst();
        this.currency = this.config.currency_id;
        this.pickingType = this.data.models["stock.picking.type"].getFirst();
        this.models = this.data.models;
        this.models["pos.session"].getFirst().login_number = parseInt(odoo.login_number);

        const models = Object.keys(this.models);
        const dynamicModels = this.data.opts.dynamicModels;
        const staticModels = models.filter((model) => !dynamicModels.includes(model));
        const deviceSync = new DevicesSynchronisation(dynamicModels, staticModels, this);

        this.deviceSync = deviceSync;
        this.data.deviceSync = deviceSync;

        // Check cashier
        this.checkPreviousLoggedCashier();

        // Add Payment Interface to Payment Method
        for (const pm of this.models["pos.payment.method"].getAll()) {
            const PaymentInterface = this.electronic_payment_interfaces[pm.use_payment_terminal];
            if (PaymentInterface) {
                pm.payment_terminal = new PaymentInterface(this, pm);
            }
        }

        // Create printer with hardware proxy, this will override related model data
        this.unwatched.printers = [];
        for (const relPrinter of this.models["pos.printer"].getAll()) {
            const printer = relPrinter.serialize();
            const HWPrinter = this.create_printer(printer);

            HWPrinter.config = printer;
            this.unwatched.printers.push(HWPrinter);

            for (const id of printer.product_categories_ids) {
                this.printers_category_ids_set.add(id);
            }
        }
        this.config.iface_printers = !!this.unwatched.printers.length;

        // Monitor product pricelist
        ["product.product", "product.pricelist.item"].forEach((model) => {
            ["create", "update"].forEach((event) => {
                this.models[model].addEventListener(
                    event,
                    this.computeProductPricelistCache.bind(this)
                );
            });
        });
        if (this.data.loadedIndexedDBProducts && this.data.loadedIndexedDBProducts.length > 0) {
            await this._loadMissingPricelistItems(this.data.loadedIndexedDBProducts);
            delete this.data.loadedIndexedDBProducts;
        }
        this.computeProductPricelistCache();
        await this.processProductAttributes();
    }
    cashMove() {
        this.hardwareProxy.openCashbox(_t("Cash in / out"));
        return makeAwaitable(this.dialog, CashMovePopup);
    }
    async closeSession() {
        const info = await this.getClosePosInfo();

        if (info) {
            this.dialog.add(ClosePosPopup, info);
        }
    }
    async processProductAttributes() {
        const productIds = new Set();
        const productTmplIds = new Set();
        const productByTmplId = {};

        for (const product of this.models["product.product"].getAll()) {
            if (product.product_template_variant_value_ids.length > 0) {
                productTmplIds.add(product.raw.product_tmpl_id);
                productIds.add(product.id);

                if (!productByTmplId[product.raw.product_tmpl_id]) {
                    productByTmplId[product.raw.product_tmpl_id] = [];
                }

                productByTmplId[product.raw.product_tmpl_id].push(product);
            }
        }

        if (productIds.size > 0) {
            await this.data.searchRead("product.product", [
                "&",
                ["id", "not in", [...productIds]],
                ["product_tmpl_id", "in", [...productTmplIds]],
            ]);
        }

        for (const product of this.models["product.product"].filter(
            (p) => !productIds.has(p.id) && p.product_template_variant_value_ids.length > 0
        )) {
            productByTmplId[product.raw.product_tmpl_id].push(product);
        }

        for (const products of Object.values(productByTmplId)) {
            const nbrProduct = products.length;

            for (let i = 0; i < nbrProduct - 1; i++) {
                products[i].available_in_pos = false;
                this.mainProductVariant[products[i].id] = products[nbrProduct - 1];
            }
        }
    }

    async onDeleteOrder(order) {
        if (order.get_orderlines().length > 0) {
            const confirmed = await ask(this.dialog, {
                title: _t("Existing orderlines"),
                body: _t(
                    "%s has a total amount of %s, are you sure you want to delete this order?",
                    order.pos_reference,
                    this.env.utils.formatCurrency(order.get_total_with_tax())
                ),
            });
            if (!confirmed) {
                return false;
            }
        }
        const orderIsDeleted = await this.deleteOrders([order]);
        if (orderIsDeleted) {
            order.uiState.displayed = false;
            this.afterOrderDeletion();
        }
        return orderIsDeleted;
    }
    afterOrderDeletion() {
        this.set_order(this.get_open_orders().at(-1) || this.createNewOrder());
    }

    async deleteOrders(orders, serverIds = []) {
        const ids = new Set();
        for (const order of orders) {
            if (order && (await this._onBeforeDeleteOrder(order))) {
                if (
                    typeof order.id === "number" &&
                    Object.keys(order.last_order_preparation_change.lines).length > 0
                ) {
                    await this.checkPreparationStateAndSentOrderInPreparation(order, true);
                }

                const cancelled = this.removeOrder(order, false);
                this.removePendingOrder(order);
                if (!cancelled) {
                    return false;
                } else if (typeof order.id === "number") {
                    ids.add(order.id);
                }
            } else {
                return false;
            }
        }

        if (serverIds.length > 0) {
            for (const id of serverIds) {
                if (typeof id !== "number") {
                    continue;
                }
                ids.add(id);
            }
        }

        if (ids.size > 0) {
            await this.data.callRelated("pos.order", "action_pos_order_cancel", [Array.from(ids)]);
            return true;
        }

        return true;
    }
    /**
     * Override to do something before deleting the order.
     * Make sure to return true to proceed on deleting the order.
     * @param {*} order
     * @returns {boolean}
     */
    async _onBeforeDeleteOrder(order) {
        return true;
    }

    computeProductPricelistCache(data) {
        if (data) {
            data = this.models[data.model].readMany(data.ids);
        }
        computeProductPricelistCache(this, data);
    }

    async _loadMissingPricelistItems(products) {
        const validProducts = products.filter((product) => typeof product.id === "number");
        if (!validProducts.length) {
            return;
        }
        const product_tmpl_ids = validProducts.map((product) => product.raw.product_tmpl_id);
        const product_ids = validProducts.map((product) => product.id);
        await this.data.callRelated("pos.session", "get_pos_ui_product_pricelist_item_by_product", [
            odoo.pos_session_id,
            product_tmpl_ids,
            product_ids,
            this.config.id,
        ]);
    }

    async afterProcessServerData() {
        const paidUnsyncedOrderIds = this.models["pos.order"]
            .filter((order) => order.isUnsyncedPaid)
            .map((order) => order.id);

        if (paidUnsyncedOrderIds.length > 0) {
            this.addPendingOrder(paidUnsyncedOrderIds);
        }

        this.data.models["pos.order"]
            .filter((order) => order._isResidual)
            .forEach((order) => (order.state = "cancel"));

        // Adding the not synced paid orders to the pending orders
        const openOrders = this.data.models["pos.order"].filter((order) => !order.finalized);
        this.syncAllOrders();

        if (!this.config.module_pos_restaurant) {
            this.selectedOrderUuid = openOrders.length
                ? openOrders[openOrders.length - 1].uuid
                : this.add_new_order().uuid;
        }

        this.markReady();
        this.showScreen(this.firstScreen);
        await this.deviceSync.readDataFromServer();
        if (this.config.customer_display_type !== "none") {
            openCustomerDisplay(
                this.getDisplayDeviceIP(),
                this.config.access_token,
                this.config.id
            );
        }
    }

    get productListViewMode() {
        const viewMode = this.productListView && this.ui.isSmall ? this.productListView : "grid";
        if (viewMode === "grid") {
            return "d-grid gap-2";
        } else {
            return "";
        }
    }
    get productViewMode() {
        const viewMode = this.productListView && this.ui.isSmall ? this.productListView : "grid";
        if (viewMode === "grid") {
            return "flex-column";
        } else {
            return "flex-row-reverse justify-content-between m-1";
        }
    }
    getProductPriceFormatted(product) {
        const formattedUnitPrice = this.env.utils.formatCurrency(this.getProductPrice(product));

        if (product.to_weight) {
            return `${formattedUnitPrice}/${product.uom_id.name}`;
        } else {
            return formattedUnitPrice;
        }
    }
    async openConfigurator(product, opts = {}) {
        const attrById = this.models["product.attribute"].getAllBy("id");
        let attributeLines = product.attribute_line_ids.filter(
            (attr) => attr.attribute_id?.id in attrById
        );
        if (opts.code) {
            attributeLines = attributeLines.filter(
                (attr) => attr.attribute_id.create_variant === "no_variant"
            );
        }
        const attributeLinesValues = attributeLines.map((attr) => attr.product_template_value_ids);
        if (attributeLinesValues.some((values) => values.length > 1 || values[0].is_custom)) {
            let defaultValues = {};
            const match = product.barcode && product.barcode.includes(this.searchProductWord);
            if (this.searchProductWord && match) {
                defaultValues = Object.fromEntries(
                    product.product_template_variant_value_ids.map((value) => [
                        value.attribute_line_id.id,
                        value.id.toString(),
                    ])
                );
            }
            return await makeAwaitable(this.dialog, ProductConfiguratorPopup, {
                product: product,
                hideAlwaysVariants: opts.hideAlwaysVariants,
                defaultValues: defaultValues,
            });
        }
        return {
            attribute_value_ids: attributeLinesValues.map((values) => values[0].id),
            attribute_custom_values: [],
            price_extra: attributeLinesValues
                .filter((attr) => attr[0].attribute_id.create_variant !== "always")
                .reduce((acc, values) => acc + values[0].price_extra, 0),
            quantity: 1,
        };
    }
    getDefaultSearchDetails() {
        return {
            fieldName: "RECEIPT_NUMBER",
            searchTerm: "",
        };
    }

    async setDiscountFromUI(line, val) {
        line.set_discount(val);
    }

    getDefaultPricelist() {
        const current_order = this.get_order();
        if (current_order) {
            return current_order.pricelist_id;
        }
        return this.config.pricelist_id;
    }

    async set_tip(tip) {
        const currentOrder = this.get_order();
        const tipProduct = this.config.tip_product_id;
        let line = currentOrder.lines.find((line) => line.product_id.id === tipProduct.id);

        if (line) {
            line.set_unit_price(tip);
        } else {
            line = await this.addLineToCurrentOrder(
                { product_id: tipProduct, price_unit: tip },
                {}
            );
        }

        currentOrder.is_tipped = true;
        currentOrder.tip_amount = tip;
        return line;
    }

    selectOrderLine(order, line) {
        order.select_orderline(line);
        this.numpadMode = "quantity";
    }
    // This method should be called every time a product is added to an order.
    // The configure parameter is available if the orderline already contains all
    // the information without having to be calculated. For example, importing a SO.
    async addLineToCurrentOrder(vals, opts = {}, configure = true) {
        let order = this.get_order();
        if (!order) {
            order = this.add_new_order();
        }
        return await this.addLineToOrder(vals, order, opts, configure);
    }

    async addLineToOrder(vals, order, opts = {}, configure = true) {
        let merge = true;
        order.assert_editable();

        const options = {
            ...opts,
        };

        if ("price_unit" in vals) {
            merge = false;
        }

        if (typeof vals.product_id == "number") {
            vals.product_id = this.data.models["product.product"].get(vals.product_id);
        }
        const product = vals.product_id;

        const values = {
            price_type: "price_unit" in vals ? "manual" : "original",
            price_extra: 0,
            price_unit: 0,
            order_id: this.get_order(),
            qty: 1,
            tax_ids: product.taxes_id.map((tax) => ["link", tax]),
            ...vals,
        };

        // Handle refund constraints
        if (
            order.doNotAllowRefundAndSales() &&
            order._isRefundOrder() &&
            (!values.qty || values.qty > 0)
        ) {
            this.dialog.add(AlertDialog, {
                title: _t("Refund and Sales not allowed"),
                body: _t("It is not allowed to mix refunds and sales"),
            });
            return;
        }

        // In case of configurable product a popup will be shown to the user
        // We assign the payload to the current values object.
        // ---
        // This actions cannot be handled inside pos_order.js or pos_order_line.js
        if (values.product_id.isConfigurable() && configure) {
            const payload = await this.openConfigurator(values.product_id, opts);

            if (payload) {
                const productFound = this.models["product.product"]
                    .filter((p) => p.raw?.product_template_variant_value_ids?.length > 0)
                    .find((p) =>
                        p.raw.product_template_variant_value_ids.every((v) =>
                            payload.attribute_value_ids.includes(v)
                        )
                    );

                Object.assign(values, {
                    attribute_value_ids: payload.attribute_value_ids
                        .filter((a) => {
                            if (productFound) {
                                const attr =
                                    this.data.models["product.template.attribute.value"].get(a);
                                return (
                                    attr.is_custom || attr.attribute_id.create_variant !== "always"
                                );
                            }
                            return true;
                        })
                        .map((id) => [
                            "link",
                            this.data.models["product.template.attribute.value"].get(id),
                        ]),
                    custom_attribute_value_ids: Object.entries(payload.attribute_custom_values).map(
                        ([id, cus]) => [
                            "create",
                            {
                                custom_product_template_attribute_value_id:
                                    this.data.models["product.template.attribute.value"].get(id),
                                custom_value: cus,
                            },
                        ]
                    ),
                    price_extra: values.price_extra + payload.price_extra,
                    qty: payload.qty || values.qty,
                    product_id: productFound || values.product_id,
                });
            } else {
                return;
            }
        } else if (values.product_id.product_template_variant_value_ids.length > 0) {
            // Verify price extra of variant products
            const priceExtra = values.product_id.product_template_variant_value_ids
                .filter((attr) => attr.attribute_id.create_variant !== "always")
                .reduce((acc, attr) => acc + attr.price_extra, 0);
            values.price_extra += priceExtra;
        }

        // In case of clicking a combo product a popup will be shown to the user
        // It will return the combo prices and the selected products
        // ---
        // This actions cannot be handled inside pos_order.js or pos_order_line.js
        if (values.product_id.isCombo() && configure) {
            const payload = await makeAwaitable(this.dialog, ComboConfiguratorPopup, {
                product: values.product_id,
            });

            if (!payload) {
                return;
            }

            const comboPrices = computeComboItems(
                values.product_id,
                payload,
                order.pricelist_id,
                this.data.models["decimal.precision"].getAll(),
                this.data.models["product.template.attribute.value"].getAllBy("id")
            );

            values.combo_line_ids = comboPrices.map((comboItem) => [
                "create",
                {
                    product_id: comboItem.combo_item_id.product_id,
                    tax_ids: comboItem.combo_item_id.product_id.taxes_id.map((tax) => [
                        "link",
                        tax,
                    ]),
                    combo_item_id: comboItem.combo_item_id,
                    price_unit: comboItem.price_unit,
                    price_type: "automatic",
                    order_id: order,
                    qty: 1,
                    attribute_value_ids: comboItem.attribute_value_ids?.map((attr) => [
                        "link",
                        attr,
                    ]),
                    custom_attribute_value_ids: Object.entries(
                        comboItem.attribute_custom_values
                    ).map(([id, cus]) => [
                        "create",
                        {
                            custom_product_template_attribute_value_id:
                                this.data.models["product.template.attribute.value"].get(id),
                            custom_value: cus,
                        },
                    ]),
                },
            ]);
        }

        // In the case of a product with tracking enabled, we need to ask the user for the lot/serial number.
        // It will return an instance of pos.pack.operation.lot
        // ---
        // This actions cannot be handled inside pos_order.js or pos_order_line.js
        const code = opts.code;
        let pack_lot_ids = {};
        if (values.product_id.isTracked() && (configure || code)) {
            const packLotLinesToEdit =
                (!values.product_id.isAllowOnlyOneLot() &&
                    this.get_order()
                        .get_orderlines()
                        .filter((line) => !line.get_discount())
                        .find((line) => line.product_id.id === values.product_id.id)
                        ?.getPackLotLinesToEdit()) ||
                [];

            // if the lot information exists in the barcode, we don't need to ask it from the user.
            if (code && code.type === "lot") {
                // consider the old and new packlot lines
                const modifiedPackLotLines = Object.fromEntries(
                    packLotLinesToEdit.filter((item) => item.id).map((item) => [item.id, item.text])
                );
                const newPackLotLines = [{ lot_name: code.code }];
                pack_lot_ids = { modifiedPackLotLines, newPackLotLines };
            } else {
                pack_lot_ids = await this.editLots(values.product_id, packLotLinesToEdit);
            }

            if (!pack_lot_ids) {
                return;
            } else {
                const packLotLine = pack_lot_ids.newPackLotLines;
                values.pack_lot_ids = packLotLine.map((lot) => ["create", lot]);
            }
        }

        // In case of clicking a product with tracking weight enabled a popup will be shown to the user
        // It will return the weight of the product as quantity
        // ---
        // This actions cannot be handled inside pos_order.js or pos_order_line.js
        if (values.product_id.to_weight && this.config.iface_electronic_scale && configure) {
            if (values.product_id.isScaleAvailable) {
                this.scale.setProduct(values.product_id, this.getProductPrice(values.product_id));
                const weight = await this.weighProduct();
                if (weight) {
                    values.qty = weight;
                } else if (weight !== null) {
                    return;
                }
            } else {
                await values.product_id._onScaleNotAvailable();
            }
        }

        // Handle price unit
        if (!values.product_id.isCombo() && vals.price_unit === undefined) {
            values.price_unit = values.product_id.get_price(order.pricelist_id, values.qty);
        }
        const isScannedProduct = opts.code && opts.code.type === "product";
        if (values.price_extra && !isScannedProduct) {
            const price = values.product_id.get_price(
                order.pricelist_id,
                values.qty,
                values.price_extra
            );

            values.price_unit = price;
        }

        const line = this.data.models["pos.order.line"].create({ ...values, order_id: order });
        line.setOptions(options);
        this.selectOrderLine(order, line);
        if (configure) {
            this.numberBuffer.reset();
        }
        const selectedOrderline = order.get_selected_orderline();
        if (options.draftPackLotLines && configure) {
            selectedOrderline.setPackLotLines({
                ...options.draftPackLotLines,
                setQuantity: options.quantity === undefined,
            });
        }

        let to_merge_orderline;
        for (const curLine of order.lines) {
            if (curLine.id !== line.id) {
                if (curLine.can_be_merged_with(line) && merge !== false) {
                    to_merge_orderline = curLine;
                }
            }
        }

        if (to_merge_orderline) {
            to_merge_orderline.merge(line);
            line.delete();
            this.selectOrderLine(order, to_merge_orderline);
        } else if (!selectedOrderline) {
            this.selectOrderLine(order, order.get_last_orderline());
        }

        if (product.tracking === "serial") {
            this.selectedOrder.get_selected_orderline().setPackLotLines({
                modifiedPackLotLines: pack_lot_ids.modifiedPackLotLines ?? [],
                newPackLotLines: pack_lot_ids.newPackLotLines ?? [],
                setQuantity: true,
            });
        }
        if (configure) {
            this.numberBuffer.reset();
        }

        // FIXME: Put this in an effect so that we don't have to call it manually.
        order.recomputeOrderData();

        if (configure) {
            this.numberBuffer.reset();
        }

        this.hasJustAddedProduct = true;
        clearTimeout(this.productReminderTimeout);
        this.productReminderTimeout = setTimeout(() => {
            this.hasJustAddedProduct = false;
        }, 3000);

        // FIXME: If merged with another line, this returned object is useless.
        return line;
    }

    create_printer(config) {
        const url = deduceUrl(config.proxy_ip || "");
        return new HWPrinter({ url });
    }
    async _loadFonts() {
        return new Promise(function (resolve, reject) {
            // Waiting for fonts to be loaded to prevent receipt printing
            // from printing empty receipt while loading Inconsolata
            // ( The font used for the receipt )
            waitForWebfonts(["Lato", "Inconsolata"], function () {
                resolve();
            });
            // The JS used to detect font loading is not 100% robust, so
            // do not wait more than 5sec
            setTimeout(resolve, 5000);
        });
    }

    setSelectedCategory(categoryId) {
        if (categoryId === this.selectedCategory?.id) {
            if (this.selectedCategory.parent_id) {
                this.selectedCategory = this.selectedCategory.parent_id;
            } else {
                this.selectedCategory = this.models["pos.category"].get(0);
            }
        } else {
            this.selectedCategory = this.models["pos.category"].get(categoryId);
        }
    }

    /**
     * Remove the order passed in params from the list of orders
     * @param order
     */
    removeOrder(order, removeFromServer = true) {
        if (this.isOpenOrderShareable() || removeFromServer) {
            if (typeof order.id === "number" && !order.finalized) {
                this.addPendingOrder([order.id], true);
                this.syncAllOrdersDebounced();
            }
        }

        if (typeof order.id === "string" && order.finalized) {
            this.addPendingOrder([order.id]);
            return;
        }

        return this.data.localDeleteCascade(order);
    }

    /**
     * Return the current cashier (in this case, the user)
     * @returns {name: string, id: int, role: string}
     */
    get_cashier() {
        this.user._role = this.user.raw.role;
        return this.user;
    }
    get_cashier_user_id() {
        return this.user.id;
    }
    get orderPreparationCategories() {
        if (this.printers_category_ids_set) {
            return new Set([...this.printers_category_ids_set]);
        }
        return new Set();
    }
    cashierHasPriceControlRights() {
        return !this.config.restrict_price_control || this.get_cashier()._role == "manager";
    }
    get currentSequenceNumber() {
        return this._sequenceNumber || 1;
    }
    getNextSequenceNumber() {
        const sessionId = this.session.id;
        const configId = this.config.id;
        const storedData = localStorage.getItem("pos.sequenceNumbers") || "{}";
        const cache = JSON.parse(storedData);

        if (!cache[configId]) {
            cache[configId] = {};
        }
        // Cleanup: Remove sequence numbers for previous sessions under the same configId
        // If we used only sessionId, we wouldn't be able to remove outdated session data properly,
        // because some session IDs might belong to a different configuration, which we must preserve.
        for (const sid in cache[configId]) {
            if (sid !== String(sessionId)) {
                delete cache[configId][sid];
            }
        }

        if (!cache[configId][sessionId]) {
            cache[configId][sessionId] = 0;
        }

        cache[configId][sessionId] += 1;
        this._sequenceNumber = cache[configId][sessionId];
        localStorage.setItem("pos.sequenceNumbers", JSON.stringify(cache));

        return this._sequenceNumber;
    }
    generate_unique_id() {
        // Generates a public identification number for the order.
        // The generated number must be unique and sequential. They are made 12 digit long
        // to fit into EAN-13 barcodes, should it be needed

        function zero_pad(num, size) {
            var s = "" + num;
            while (s.length < size) {
                s = "0" + s;
            }
            return s;
        }
        return (
            zero_pad(this.session.id, 5) +
            "-" +
            zero_pad(parseInt(odoo.login_number), 3) +
            "-" +
            zero_pad(this.getNextSequenceNumber(), 4)
        );
    }
    createNewOrder(data = {}) {
        const fiscalPosition = this.models["account.fiscal.position"].find(
            (fp) => fp.id === this.config.default_fiscal_position_id?.id
        );

        const uniqId = this.generate_unique_id();
        const order = this.models["pos.order"].create({
            session_id: this.session,
            company_id: this.company,
            config_id: this.config,
            picking_type_id: this.pickingType,
            user_id: this.user,
            sequence_number: this.currentSequenceNumber,
            access_token: uuidv4(),
            ticket_code: random5Chars(),
            fiscal_position_id: fiscalPosition,
            name: _t("Order %s", uniqId),
            pos_reference: uniqId,
            ...data,
        });

        order.set_pricelist(this.config.pricelist_id);
        return order;
    }
    add_new_order(data = {}) {
        if (this.get_order()) {
            this.get_order().updateSavedQuantity();
        }

        const order = this.createNewOrder(data);
        this.selectedOrderUuid = order.uuid;
        this.searchProductWord = "";
        return order;
    }

    selectNextOrder() {
        const orders = this.models["pos.order"].filter((order) => !order.finalized);
        if (orders.length > 0) {
            this.selectedOrderUuid = orders[0].uuid;
        } else {
            this.add_new_order();
        }
    }

    addPendingOrder(orderIds, remove = false) {
        if (remove) {
            for (const id of orderIds) {
                this.pendingOrder["create"].delete(id);
                this.pendingOrder["write"].delete(id);
            }

            this.pendingOrder["delete"].add(...orderIds);
            return true;
        }

        for (const id of orderIds) {
            if (typeof id === "number") {
                this.pendingOrder["write"].add(id);
            } else {
                this.pendingOrder["create"].add(id);
            }
        }

        return true;
    }

    getPendingOrder() {
        const orderToCreate = this.models["pos.order"]
            .filter((order) => this.pendingOrder.create.has(order.id) && order.hasItemsOrPayLater)
            .filter(Boolean);
        const orderToUpdate = this.models["pos.order"]
            .readMany(Array.from(this.pendingOrder.write))
            .filter(Boolean);
        const orderToDelele = this.models["pos.order"]
            .readMany(Array.from(this.pendingOrder.delete))
            .filter(Boolean);

        return {
            orderToDelele,
            orderToCreate,
            orderToUpdate,
        };
    }

    getOrderIdsToDelete() {
        return [...this.pendingOrder.delete];
    }

    removePendingOrder(order) {
        this.pendingOrder["create"].delete(order.id);
        this.pendingOrder["write"].delete(order.id);
        this.pendingOrder["delete"].delete(order.id);
        return true;
    }

    clearPendingOrder() {
        this.pendingOrder = {
            create: new Set(),
            write: new Set(),
            delete: new Set(),
        };
    }

    getSyncAllOrdersContext(orders, options = {}) {
        return {
            config_id: this.config.id,
            login_number: parseInt(odoo.login_number),
            ...(options.context || {}),
        };
    }

    // There for override
    async preSyncAllOrders(orders) {}
    postSyncAllOrders(orders) {}
    async syncAllOrders(options = {}) {
        const { orderToCreate, orderToUpdate } = this.getPendingOrder();
        let orders = options.orders || [...orderToCreate, ...orderToUpdate];

        // Filter out orders that are already being synced
        orders = orders.filter((order) => !this.syncingOrders.has(order.id));

        try {
            const orderIdsToDelete = this.getOrderIdsToDelete();
            if (orderIdsToDelete.length > 0) {
                await this.deleteOrders([], orderIdsToDelete);
            }

            const context = this.getSyncAllOrdersContext(orders, options);
            await this.preSyncAllOrders(orders);

            // Allow us to force the sync of the orders In the case of
            // pos_restaurant is usefull to get unsynced orders
            // for a specific table
            if (orders.length === 0) {
                return;
            }

            // Add order IDs to the syncing set
            orders.forEach((order) => this.syncingOrders.add(order.id));

            // Re-compute all taxes, prices and other information needed for the backend
            for (const order of orders) {
                order.recomputeOrderData();
            }

            const serializedOrder = orders.map((order) => order.serialize({ orm: true }));
            const data = await this.data.call("pos.order", "sync_from_ui", [serializedOrder], {
                context,
            });
            const missingRecords = await this.data.missingRecursive(data);
            const newData = this.models.loadData(missingRecords, [], false);

            for (const line of newData["pos.order.line"]) {
                const refundedOrderLine = line.refunded_orderline_id;

                if (refundedOrderLine) {
                    const order = refundedOrderLine.order_id;
                    if (order) {
                        delete order.uiState.lineToRefund[refundedOrderLine.uuid];
                    }
                    refundedOrderLine.refunded_qty = refundedOrderLine.refund_orderline_ids.reduce(
                        (sum, obj) => sum + Math.abs(obj.qty),
                        0
                    );
                }
            }

            this.postSyncAllOrders(newData["pos.order"]);

            if (data["pos.session"].length > 0) {
                // Replace the original session by the rescue one. And the rescue one will have
                // a higher id than the original one since it's the last one created.
                const session = this.models["pos.session"].sort((a, b) => a.id - b.id)[0];
                session.delete();
                this.models["pos.order"]
                    .getAll()
                    .filter((order) => order.state === "draft")
                    .forEach((order) => (order.session_id = this.session));
            }

            // Remove only synced orders from the pending orders
            orders.forEach((o) => this.removePendingOrder(o));
            orders.map((order) => order.clearCommands());
            return newData["pos.order"];
        } catch (error) {
            if (options.throw) {
                throw error;
            }

            // After an error on the sync, verify order state by asking the server
            if (error instanceof ConnectionLostError) {
                console.warn("Offline mode active, order will be synced later");
            } else {
                this.deviceSync.readDataFromServer();
            }

            return error;
        } finally {
            orders.forEach((order) => this.syncingOrders.delete(order.id));
        }
    }

    push_single_order(order) {
        return this.pushOrderMutex.exec(() => this.syncAllOrders(order));
    }

    setLoadingOrderState(bool) {
        this.loadingOrderState = bool;
    }
    async pay() {
        const currentOrder = this.get_order();

        if (!currentOrder.canPay()) {
            return;
        }

        if (
            currentOrder.lines.some(
                (line) => line.get_product().tracking !== "none" && !line.has_valid_product_lot()
            ) &&
            (this.pickingType.use_create_lots || this.pickingType.use_existing_lots)
        ) {
            const confirmed = await ask(this.env.services.dialog, {
                title: _t("Some Serial/Lot Numbers are missing"),
                body: _t(
                    "You are trying to sell products with serial/lot numbers, but some of them are not set.\nWould you like to proceed anyway?"
                ),
            });
            if (confirmed) {
                this.mobile_pane = "right";
                this.env.services.pos.showScreen("PaymentScreen", {
                    orderUuid: this.selectedOrderUuid,
                });
            }
        } else {
            this.mobile_pane = "right";
            this.env.services.pos.showScreen("PaymentScreen", {
                orderUuid: this.selectedOrderUuid,
            });
        }
    }
    async getServerOrders() {
        return await this.loadServerOrders([
            ["config_id", "in", [...this.config.raw.trusted_config_ids, this.config.id]],
            ["state", "=", "draft"],
        ]);
    }
    async loadServerOrders(domain) {
        const orders = await this.data.searchRead("pos.order", domain);
        for (const order of orders) {
            order.update({
                config_id: this.config,
                session_id: this.session,
            });
        }
        return orders;
    }
    async getProductInfo(product, quantity, priceExtra = 0) {
        const order = this.get_order();
        // check back-end method `get_product_info_pos` to see what it returns
        // We do this so it's easier to override the value returned and use it in the component template later
        const productInfo = await this.data.call("product.product", "get_product_info_pos", [
            [product.id],
            product.get_price(order.pricelist_id, quantity, priceExtra),
            quantity,
            this.config.id,
        ]);

        const priceWithoutTax = productInfo["all_prices"]["price_without_tax"];
        const margin = priceWithoutTax - product.standard_price;
        const orderPriceWithoutTax = order.get_total_without_tax();
        const orderCost = order.get_total_cost();
        const orderMargin = orderPriceWithoutTax - orderCost;

        const costCurrency = this.env.utils.formatCurrency(product.standard_price);
        const marginCurrency = this.env.utils.formatCurrency(margin);
        const marginPercent = priceWithoutTax
            ? Math.round((margin / priceWithoutTax) * 10000) / 100
            : 0;
        const orderPriceWithoutTaxCurrency = this.env.utils.formatCurrency(orderPriceWithoutTax);
        const orderCostCurrency = this.env.utils.formatCurrency(orderCost);
        const orderMarginCurrency = this.env.utils.formatCurrency(orderMargin);
        const orderMarginPercent = orderPriceWithoutTax
            ? Math.round((orderMargin / orderPriceWithoutTax) * 10000) / 100
            : 0;
        return {
            costCurrency,
            marginCurrency,
            marginPercent,
            orderPriceWithoutTaxCurrency,
            orderCostCurrency,
            orderMarginCurrency,
            orderMarginPercent,
            productInfo,
        };
    }
    async getClosePosInfo() {
        return await this.data.call("pos.session", "get_closing_control_data", [[this.session.id]]);
    }
    // return the current order
    get_order() {
        if (!this.selectedOrderUuid) {
            return undefined;
        }

        return this.models["pos.order"].getBy("uuid", this.selectedOrderUuid);
    }
    get selectedOrder() {
        return this.get_order();
    }

    // change the current order
    set_order(order, options) {
        if (this.get_order()) {
            this.get_order().updateSavedQuantity();
        }
        this.selectedOrderUuid = order?.uuid;
    }

    // return the list of unpaid orders
    get_open_orders() {
        return this.models["pos.order"].filter((o) => !o.finalized && o.uiState.displayed);
    }

    // To be used in the context of closing the POS
    // Saves the order locally and try to send it to the backend.
    // If there is an error show a popup
    async push_orders_with_closing_popup(opts = {}) {
        try {
            await this.syncAllOrders(opts);
            return true;
        } catch (error) {
            console.warn(error);
            const reason = this.failed
                ? _t(
                      "Some orders could not be submitted to " +
                          "the server due to configuration errors. " +
                          "You can exit the Point of Sale, but do " +
                          "not close the session before the issue " +
                          "has been resolved."
                  )
                : _t(
                      "Some orders could not be submitted to " +
                          "the server due to internet connection issues. " +
                          "You can exit the Point of Sale, but do " +
                          "not close the session before the issue " +
                          "has been resolved."
                  );
            await ask(this.dialog, {
                title: _t("Offline Orders"),
                body: reason,
            });
            return false;
        }
    }

    prepareProductBaseLineForTaxesComputationExtraValues(product, p = false) {
        const currency = this.config.currency_id;
        const extraValues = { currency_id: currency };
        const priceList = this.getDefaultPricelist();
        const priceUnit = p === false ? product.get_price(priceList, 1) : p;

        let taxes = product.taxes_id;

        // Fiscal position.
        const order = this.get_order();
        if (order && order.fiscal_position_id) {
            taxes = getTaxesAfterFiscalPosition(taxes, order.fiscal_position_id, this.models);
        }

        return {
            ...extraValues,
            product_id: accountTaxHelpers.eval_taxes_computation_prepare_product_values(
                this.config._product_default_values,
                product
            ),
            quantity: 1,
            price_unit: priceUnit,
            tax_ids: taxes,
        };
    }

    getProducePriceDetails(product, p = false) {
        const company = this.company;
        const baseLine = accountTaxHelpers.prepare_base_line_for_taxes_computation(
            {},
            this.prepareProductBaseLineForTaxesComputationExtraValues(product, p)
        );
        accountTaxHelpers.add_tax_details_in_base_line(baseLine, company);
        accountTaxHelpers.round_base_lines_tax_details([baseLine], company);

        const results = baseLine.tax_details;
        for (const taxData of results.taxes_data) {
            Object.assign(taxData, taxData.tax);
        }
        return results;
    }

    getProductPrice(product, p = false) {
        const taxesData = this.getProducePriceDetails(product, p);
        if (this.config.iface_tax_included === "total") {
            return taxesData.total_included;
        } else {
            return taxesData.total_excluded;
        }
    }

    /**
     * @param {str} terminalName
     */
    getPendingPaymentLine(terminalName) {
        for (const order of this.models["pos.order"].getAll()) {
            const paymentLine = order.payment_ids.find(
                (paymentLine) =>
                    paymentLine.payment_method_id.use_payment_terminal === terminalName &&
                    !paymentLine.is_done()
            );
            if (paymentLine) {
                return paymentLine;
            }
        }
    }

    get linesToRefund() {
        return this.models["pos.order"].reduce((acc, order) => {
            acc.push(...Object.values(order.uiState.lineToRefund));
            return acc;
        }, []);
    }

    isProductQtyZero(qty) {
        const dp = this.models["decimal.precision"].find(
            (dp) => dp.name === "Product Unit of Measure"
        );
        return floatIsZero(qty, dp.digits);
    }

    disallowLineQuantityChange() {
        return false;
    }

    restrictLineDiscountChange() {
        return false;
    }

    restrictLinePriceChange() {
        return false;
    }

    getCurrencySymbol() {
        return this.currency ? this.currency.symbol : "$";
    }
    isOpenOrderShareable() {
        return this.config.raw.trusted_config_ids.length > 0;
    }
    switchPane() {
        this.mobile_pane = this.mobile_pane === "left" ? "right" : "left";
    }
    switchPaneTicketScreen() {
        this.ticket_screen_mobile_pane =
            this.ticket_screen_mobile_pane === "left" ? "right" : "left";
    }
    async logEmployeeMessage(action, message) {
        await this.data.call(
            "pos.session",
            "log_partner_message",
            [this.session.id, this.user.partner_id.id, action, message],
            {},
            true
        );
    }
    showScreen(name, props) {
        if (name === "PaymentScreen" && !props.orderUuid) {
            name = "ProductScreen";
        }
        if (name === "ProductScreen") {
            this.get_order()?.deselect_orderline();
        }
        const component = registry.category("pos_screens").get(name);
        if (
            (component.updatePreviousScreen ?? true) &&
            (this.mainScreen.component?.updatePreviousScreen ?? true)
        ) {
            this.previousScreen = this.mainScreen.component?.name;
        }
        this.mainScreen = { component, props };
        // Save the screen to the order so that it is shown again when the order is selected.
        if (component.storeOnOrder ?? true) {
            this.get_order()?.set_screen_data({ name, props });
        }

        return true;
    }
    orderExportForPrinting(order) {
        const headerData = this.getReceiptHeaderData(order);
        const baseUrl = this.session._base_url;
        return order.export_for_printing(baseUrl, headerData);
    }
    async printReceipt({
        basic = false,
        order = this.get_order(),
        printBillActionTriggered = false,
    } = {}) {
        const result = await this.printer.print(
            OrderReceipt,
            {
                data: this.orderExportForPrinting(order),
                formatCurrency: this.env.utils.formatCurrency,
                basic_receipt: basic,
            },
            { webPrintFallback: true }
        );
        if (!printBillActionTriggered) {
            order.nb_print += 1;
            if (typeof order.id === "number" && result) {
                await this.data.write("pos.order", [order.id], { nb_print: order.nb_print });
            }
        }
        return true;
    }
    getOrderChanges(skipped = false, order = this.get_order()) {
        return getOrderChanges(order, skipped, this.orderPreparationCategories);
    }
    async checkPreparationStateAndSentOrderInPreparation(order, cancelled = false) {
        if (typeof order.id !== "number") {
            return this.sendOrderInPreparation(order, cancelled);
        }

        const data = await this.data.call("pos.order", "get_preparation_change", [order.id]);
        const rawchange = data.last_order_preparation_change || "{}";
        const lastChanges = JSON.parse(rawchange);
        const lastServerDate = DateTime.fromSQL(lastChanges.metadata?.serverDate).toUTC();
        const lastLocalDate = DateTime.fromSQL(
            order.last_order_preparation_change?.metadata?.serverDate
        ).toUTC();

        if (lastServerDate.isValid && lastServerDate.ts != lastLocalDate.ts) {
            this.dialog.add(AlertDialog, {
                title: _t("Order Outdated"),
                body: _t(
                    "The order has been modified on another device. If you have modified existing " +
                        "order lines, check that your changes have not been overwritten.\n\n" +
                        "The order will be sent to the server with the last changes made on this device."
                ),
            });

            // Update before syncing otherwise it will overwrite the last change
            order.last_order_preparation_change = lastChanges;
            await this.syncAllOrders({ orders: [order] });
            return;
        }

        return this.sendOrderInPreparation(order, cancelled);
    }
    // Now the printer should work in PoS without restaurant
    async sendOrderInPreparation(order, cancelled = false) {
        let isPrinted = false;
        if (this.printers_category_ids_set.size) {
            try {
                const orderChange = changesToOrder(
                    order,
                    false,
                    this.orderPreparationCategories,
                    cancelled
                );
                isPrinted = await this.printChanges(order, orderChange);
            } catch (e) {
                console.info("Failed in printing the changes in the order", e);
            }
        }

        order.updateLastOrderChange();
        // Ensure that other devices are aware of the changes
        // Otherwise several devices can print the same changes
        // We need to check if a preparation display is configured to avoid unnecessary sync
        if (isPrinted && !this.config["<-pos_preparation_display.display.pos_config_ids"]?.length) {
            await this.syncAllOrders({ orders: [order] });
        }
    }
    async sendOrderInPreparationUpdateLastChange(o, cancelled = false) {
        // Always display a "ConnectionLostError" when the user tries to send an order to the kitchen while offline
        if (this.data.network.offline) {
            this.data.network.warningTriggered = false;
            throw new ConnectionLostError();
        }
        await this.checkPreparationStateAndSentOrderInPreparation(o, cancelled);
    }

    async printChanges(order, orderChange) {
        let isPrinted = false;
        const unsuccedPrints = [];
        const isPartOfCombo = (line) =>
            line.isCombo || this.models["product.product"].get(line.product_id).type == "combo";
        const comboChanges = orderChange.new.filter(isPartOfCombo);
        const normalChanges = orderChange.new.filter((line) => !isPartOfCombo(line));
        normalChanges.sort((a, b) => {
            const sequenceA = a.pos_categ_sequence;
            const sequenceB = b.pos_categ_sequence;
            if (sequenceA === 0 && sequenceB === 0) {
                return a.pos_categ_id - b.pos_categ_id;
            }

            return sequenceA - sequenceB;
        });
        orderChange.new = [...comboChanges, ...normalChanges];

        for (const printer of this.unwatched.printers) {
            const changes = this._getPrintingCategoriesChanges(
                printer.config.product_categories_ids,
                orderChange
            );
            const anyChangesToPrint = changes.new.length;
            const diningModeUpdate = orderChange.modeUpdate;
            if (diningModeUpdate || anyChangesToPrint) {
                const printed = await this.printReceipts(
                    order,
                    printer,
                    "New",
                    changes.new,
                    true,
                    diningModeUpdate
                );
                changes.new = [];
                if (!printed) {
                    unsuccedPrints.push("Detailed Receipt");
                } else {
                    isPrinted = true;
                }
            }

            // Print all receipts related to line changes
            const toPrintArray = this.preparePrintingData(order, changes);
            for (const [key, value] of Object.entries(toPrintArray)) {
                const printed = await this.printReceipts(order, printer, key, value, false);
                if (!printed) {
                    unsuccedPrints.push(key);
                } else {
                    isPrinted = true;
                }
            }
            // Print Order Note if changed
            if (orderChange.generalNote && anyChangesToPrint) {
                const printed = await this.printReceipts(order, printer, "Message", []);
                if (!printed) {
                    unsuccedPrints.push("General Message");
                } else {
                    isPrinted = true;
                }
            }
        }

        // printing errors
        if (unsuccedPrints.length) {
            const failedReceipts = unsuccedPrints.join(", ");
            this.dialog.add(AlertDialog, {
                title: _t("Printing failed"),
                body: _t("Failed in printing %s changes of the order", failedReceipts),
            });
        }

        return isPrinted;
    }

    getPrintingChanges(order, diningModeUpdate) {
        const time = DateTime.now().toFormat("HH:mm");
        return {
            table_name: order.table_id ? order.table_id.table_number : "",
            config_name: order.config.name,
            time: time,
            tracking_number: order.tracking_number,
            takeaway: order.config.takeaway && order.takeaway,
            employee_name: order.employee_id?.name || order.user_id?.name,
            order_note: order.general_note,
            diningModeUpdate: diningModeUpdate,
        };
    }

    async getRenderedReceipt(order, title, lines, fullReceipt = false, diningModeUpdate) {
        const receipt = renderToElement("point_of_sale.OrderChangeReceipt", {
            operational_title: title,
            changes: this.getPrintingChanges(order, diningModeUpdate),
            changedlines: lines,
            fullReceipt: fullReceipt,
        });

        return receipt;
    }

    async printReceipts(order, printer, title, lines, fullReceipt = false, diningModeUpdate) {
        const receipt = await this.getRenderedReceipt(
            order,
            title,
            lines,
            fullReceipt,
            diningModeUpdate
        );
        const result = await printer.printReceipt(receipt);
        return result.successful;
    }

    preparePrintingData(order, changes) {
        const order_modifications = {};
        const pdisChangedLines = order.last_order_preparation_change.lines;

        if (changes["new"].length) {
            order_modifications["New"] = changes["new"];
        }
        if (changes["noteUpdated"].length) {
            order_modifications["Note"] = changes["noteUpdated"];
        }
        // Handle removed lines
        if (changes["cancelled"].length) {
            if (changes["new"].length) {
                order_modifications["Cancelled"] = changes["cancelled"];
            } else {
                const allCancelled = changes["cancelled"].every((line) => {
                    const pdisLine = pdisChangedLines[line.uuid + " - " + line.note];
                    return !pdisLine || pdisLine.quantity <= line.quantity;
                });
                if (
                    allCancelled &&
                    Object.keys(pdisChangedLines).length == changes["cancelled"].length
                ) {
                    order_modifications["Cancel"] = changes["cancelled"];
                } else {
                    order_modifications["Cancelled"] = changes["cancelled"];
                }
            }
        }
        return order_modifications;
    }

    _getPrintingCategoriesChanges(categories, currentOrderChange) {
        const filterFn = (change) => {
            const product = this.models["product.product"].get(change["product_id"]);
            const categoryIds = product.parentPosCategIds;

            for (const categoryId of categoryIds) {
                if (categories.includes(categoryId)) {
                    return true;
                }
            }
        };

        return {
            new: currentOrderChange["new"].filter(filterFn),
            cancelled: currentOrderChange["cancelled"].filter(filterFn),
            noteUpdated: currentOrderChange["noteUpdated"].filter(filterFn),
        };
    }

    closeScreen() {
        this.addOrderIfEmpty();
        const { name: screenName } = this.get_order().get_screen_data();
        const props = {};
        if (screenName === "PaymentScreen") {
            props.orderUuid = this.selectedOrderUuid;
        }
        this.showScreen(screenName, props);
    }

    addOrderIfEmpty() {
        if (!this.get_order()) {
            this.add_new_order();
        }
    }

    connectToProxy() {
        return new Promise((resolve, reject) => {
            this.barcodeReader?.disconnectFromProxy();
            this.loadingSkipButtonIsShown = true;
            this.hardwareProxy.autoconnect({ force_ip: this.config.proxy_ip }).then(
                () => {
                    if (this.config.iface_scan_via_proxy) {
                        this.barcodeReader?.connectToProxy();
                    }
                    resolve();
                },
                (statusText, url) => {
                    // this should reject so that it can be captured when we wait for pos.ready
                    // in the chrome component.
                    // then, if it got really rejected, we can show the error.
                    if (statusText == "error" && window.location.protocol == "https:") {
                        // FIXME POSREF this looks like it's dead code.
                        reject({
                            title: _t("HTTPS connection to IoT Box failed"),
                            body: _t(
                                "Make sure you are using IoT Box v18.12 or higher. Navigate to %s to accept the certificate of your IoT Box.",
                                url
                            ),
                            popup: "alert",
                        });
                    } else {
                        resolve();
                    }
                }
            );
        });
    }
    editPartnerContext(partner) {
        return {};
    }
    /**
     * @param {import("@point_of_sale/app/models/res_partner").ResPartner?} partner leave undefined to create a new partner
     */
    async editPartner(partner) {
        const record = await makeActionAwaitable(
            this.action,
            "point_of_sale.res_partner_action_edit_pos",
            {
                props: { resId: partner?.id },
                additionalContext: this.editPartnerContext(),
            }
        );
        const newPartner = await this.data.read("res.partner", record.config.resIds);
        return newPartner[0];
    }
    /**
     * @param {import("@point_of_sale/app/models/product_product").ProductProduct?} product leave undefined to create a new product
     */
    async editProduct(product) {
        this.action.doAction(
            product
                ? "point_of_sale.product_product_action_edit_pos"
                : "point_of_sale.product_product_action_add_pos",
            {
                props: {
                    resId: product?.id,
                    onSave: (record) => {
                        this.data.read("product.product", [record.evalContext.id]);
                        this.action.doAction({
                            type: "ir.actions.act_window_close",
                        });
                    },
                },
            }
        );
    }
    async allowProductCreation() {
        return await user.hasGroup("base.group_system");
    }
    orderDetailsProps(order) {
        return {
            resModel: "pos.order",
            resId: order.id,
            onRecordSaved: async (record) => {
                await this.data.read("pos.order", [record.evalContext.id]);
                await this.data.read(
                    "pos.payment",
                    order.payment_ids.map((p) => p.id)
                );
                this.action.doAction({
                    type: "ir.actions.act_window_close",
                });
            },
        };
    }
    async orderDetails(order) {
        this.dialog.add(FormViewDialog, this.orderDetailsProps(order));
    }
    async closePos() {
        this._resetConnectedCashier();
        // If pos is not properly loaded, we just go back to /web without
        // doing anything in the order data.
        if (!this) {
            this.redirectToBackend();
        }

        if (this.session.state === "opening_control") {
            const data = await this.data.call("pos.session", "delete_opening_control_session", [
                this.session.id,
            ]);

            if (data.status === "success") {
                this.redirectToBackend();
            }
        }

        // If there are orders in the db left unsynced, we try to sync.
        const syncSuccess = await this.push_orders_with_closing_popup();
        if (syncSuccess) {
            this.redirectToBackend();
        }
    }
    async selectPricelist(pricelist) {
        await this.get_order().set_pricelist(pricelist);
    }
    async selectPartner() {
        // FIXME, find order to refund when we are in the ticketscreen.
        const currentOrder = this.get_order();
        if (!currentOrder) {
            return false;
        }
        const currentPartner = currentOrder.get_partner();
        if (currentPartner && currentOrder.getHasRefundLines()) {
            this.dialog.add(AlertDialog, {
                title: _t("Can't change customer"),
                body: _t(
                    "This order already has refund lines for %s. We can't change the customer associated to it. Create a new order for the new customer.",
                    currentPartner.name
                ),
            });
            return currentPartner;
        }
        const payload = await makeAwaitable(this.dialog, PartnerList, {
            partner: currentPartner,
            getPayload: (newPartner) => currentOrder.set_partner(newPartner),
        });

        if (payload) {
            currentOrder.set_partner(payload);
        } else {
            currentOrder.set_partner(false);
        }

        return currentPartner;
    }
    async editLots(product, packLotLinesToEdit) {
        const isAllowOnlyOneLot = product.isAllowOnlyOneLot();
        let canCreateLots = this.pickingType.use_create_lots || !this.pickingType.use_existing_lots;

        let existingLots = [];
        try {
            existingLots = await this.data.call(
                "pos.order.line",
                "get_existing_lots",
                [this.company.id, product.id],
                {
                    context: {
                        config_id: this.config.id,
                    },
                }
            );
            if (!canCreateLots && (!existingLots || existingLots.length === 0)) {
                this.dialog.add(AlertDialog, {
                    title: _t("No existing serial/lot number"),
                    body: _t(
                        "There is no serial/lot number for the selected product, and their creation is not allowed from the Point of Sale app."
                    ),
                });
                return null;
            }
        } catch (ex) {
            console.error("Collecting existing lots failed: ", ex);
            const confirmed = await ask(this.dialog, {
                title: _t("Server communication problem"),
                body: _t(
                    "The existing serial/lot numbers could not be retrieved. \nContinue without checking the validity of serial/lot numbers ?"
                ),
                confirmLabel: _t("Yes"),
                cancelLabel: _t("No"),
            });
            if (!confirmed) {
                return null;
            }
            canCreateLots = true;
        }

        const usedLotsQty = this.models["pos.pack.operation.lot"]
            .filter(
                (lot) =>
                    lot.pos_order_line_id?.product_id?.id === product.id &&
                    lot.pos_order_line_id?.order_id?.state === "draft"
            )
            .reduce((acc, lot) => {
                if (!acc[lot.lot_name]) {
                    acc[lot.lot_name] = { total: 0, currentOrderCount: 0 };
                }
                acc[lot.lot_name].total += lot.pos_order_line_id?.qty || 0;

                if (lot.pos_order_line_id?.order_id?.id === this.selectedOrder.id) {
                    acc[lot.lot_name].currentOrderCount += lot.pos_order_line_id?.qty || 0;
                }
                return acc;
            }, {});

        // Remove lot/serial names that are already used in draft orders
        existingLots = existingLots.filter(
            (lot) => lot.product_qty > (usedLotsQty[lot.name]?.total || 0)
        );

        // Check if the input lot/serial name is already used in another order
        const isLotNameUsed = (itemValue) => {
            const totalQty = existingLots.find((lt) => lt.name == itemValue)?.product_qty || 0;
            const usedQty = usedLotsQty[itemValue]
                ? usedLotsQty[itemValue].total - usedLotsQty[itemValue].currentOrderCount
                : 0;
            return usedQty ? usedQty >= totalQty : false;
        };

        const existingLotsName = existingLots.map((l) => l.name);
        if (!packLotLinesToEdit.length && existingLotsName.length === 1) {
            // If there's only one existing lot/serial number, automatically assign it to the order line
            return { newPackLotLines: [{ lot_name: existingLotsName[0] }] };
        }
        const payload = await makeAwaitable(this.dialog, EditListPopup, {
            title: _t("Lot/Serial Number(s) Required"),
            name: product.display_name,
            isSingleItem: isAllowOnlyOneLot,
            array: packLotLinesToEdit,
            options: existingLotsName,
            customInput: canCreateLots,
            uniqueValues: product.tracking === "serial",
            isLotNameUsed: isLotNameUsed,
        });
        if (payload) {
            // Segregate the old and new packlot lines
            const modifiedPackLotLines = Object.fromEntries(
                payload.filter((item) => item.id).map((item) => [item.id, item.text])
            );
            const newPackLotLines = payload
                .filter((item) => !item.id)
                .map((item) => ({ lot_name: item.text }));

            return { modifiedPackLotLines, newPackLotLines };
        } else {
            return null;
        }
    }

    openOpeningControl() {
        if (this.shouldShowOpeningControl()) {
            this.dialog.add(
                OpeningControlPopup,
                {},
                {
                    onClose: () => {
                        if (
                            this.session.state !== "opened" &&
                            this.mainScreen.component === ProductScreen
                        ) {
                            this.closePos();
                        }
                    },
                }
            );
        }
    }
    shouldShowOpeningControl() {
        return this.session.state == "opening_control";
    }

    /**
     * Close other tabs that contain the same pos session.
     */
    closeOtherTabs() {
        // FIXME POSREF use the bus?
        localStorage["message"] = "";
        localStorage["message"] = JSON.stringify({
            message: "close_tabs",
            session: this.session.id,
        });

        window.addEventListener(
            "storage",
            (event) => {
                if (event.key === "message" && event.newValue) {
                    const msg = JSON.parse(event.newValue);
                    if (msg.message === "close_tabs" && msg.session == this.session.id) {
                        console.info("POS / Session opened in another window. EXITING POS");
                        this.closePos();
                    }
                }
            },
            false
        );
    }

    showBackButton() {
        return (
            (this.ui.isSmall && this.mainScreen.component !== ProductScreen) ||
            (this.mobile_pane === "left" && this.mainScreen.component === ProductScreen)
        );
    }
    async onClickBackButton() {
        if (this.mainScreen.component === TicketScreen) {
            if (this.ticket_screen_mobile_pane == "left") {
                this.closeScreen();
            } else {
                this.ticket_screen_mobile_pane = "left";
            }
        } else if (
            this.mobile_pane == "left" ||
            [PaymentScreen, ActionScreen].includes(this.mainScreen.component)
        ) {
            this.mobile_pane = this.mainScreen.component === PaymentScreen ? "left" : "right";
            this.showScreen("ProductScreen");
        }
    }

    showSearchButton() {
        if (this.mainScreen.component === ProductScreen) {
            return this.ui.isSmall ? this.mobile_pane === "right" : true;
        }
        return false;
    }

    doNotAllowRefundAndSales() {
        return false;
    }

    getReceiptHeaderData(order) {
        return {
            company: this.company,
            cashier: _t("Served by %s", order?.getCashierName() || this.get_cashier()?.name),
            header: this.config.receipt_header,
        };
    }

    async showQR(payment) {
        let qr;
        try {
            qr = await this.data.call("pos.payment.method", "get_qr_code", [
                [payment.payment_method_id.id],
                payment.amount,
                payment.pos_order_id.name + " " + payment.pos_order_id.tracking_number,
                "",
                this.currency.id,
                payment.pos_order_id.partner_id?.id,
            ]);
        } catch (error) {
            qr = payment.payment_method_id.default_qr;
            if (!qr) {
                let message;
                if (error instanceof ConnectionLostError) {
                    message = _t(
                        "Connection to the server has been lost. Please check your internet connection."
                    );
                } else {
                    message = error.data.message;
                }
                this.env.services.dialog.add(AlertDialog, {
                    title: _t("Failure to generate Payment QR Code"),
                    body: message,
                });
                return false;
            }
        }
        payment.qrPaymentData = {
            name: payment.payment_method_id.name,
            amount: this.env.utils.formatCurrency(payment.amount),
            qrCode: qr,
        };
        return await ask(
            this.env.services.dialog,
            {
                title: payment.name,
                line: payment,
                order: payment.pos_order_id,
                qrCode: qr,
            },
            {},
            QRPopup
        ).then((result) => {
            payment.qrPaymentData = null;
            return result;
        });
    }

    get isTicketScreenShown() {
        return this.mainScreen.component === TicketScreen;
    }

    _shouldLoadOrders() {
        return this.config.raw.trusted_config_ids.length > 0;
    }

    redirectToBackend() {
        window.location = "/odoo/action-point_of_sale.action_client_pos_menu";
    }

    getDisplayDeviceIP() {
        return this.config.proxy_ip;
    }

    isProductVariant(product) {
        return (
            this.models["product.product"].filter(
                (p) => p.raw.product_tmpl_id === product.raw.product_tmpl_id
            ).length > 1
        );
    }

    getPaymentMethodDisplayText(pm, order) {
        const { cash_rounding, only_round_cash_method } = this.config;
        const amount = order.getDefaultAmountDueToPayIn(pm);
        const fmtAmount = this.env.utils.formatCurrency(amount, false);
        if (
            lte(amount, 0, { decimals: this.currency.decimal_places }) ||
            !cash_rounding ||
            (only_round_cash_method && pm.type !== "cash")
        ) {
            return pm.name;
        } else {
            return `${pm.name} (${fmtAmount})`;
        }
    }

    clickSaveOrder() {
        this.syncAllOrders({ orders: [this.get_order()] });
        this.notification.add(_t("Order saved for later"), { type: "success" });
        this.selectEmptyOrder();
        this.mobile_pane = "right";
    }

    selectEmptyOrder() {
        const emptyOrders = this.models["pos.order"].filter(
            (order) => order.is_empty() && !order.finalized
        );
        if (emptyOrders.length > 0) {
            this.set_order(emptyOrders[0]);
            return;
        }
        this.add_new_order();
    }

    get showSaveOrderButton() {
        return this.isOpenOrderShareable();
    }

    async isSessionDeleted() {
        const session = await this.data.read("pos.session", [this.session.id]);
        return session[0] === undefined;
    }

    weighProduct() {
        return makeAwaitable(this.env.services.dialog, ScaleScreen);
    }
}

PosStore.prototype.electronic_payment_interfaces = {};

/**
 * Call this function to map your PaymentInterface implementation to
 * the use_payment_terminal field. When the POS loads it will take
 * care of instantiating your interface and setting it on the right
 * payment methods.
 *
 * @param {string} use_payment_terminal - value used in the
 * use_payment_terminal selection field
 *
 * @param {Object} ImplementedPaymentInterface - implemented
 * PaymentInterface
 */
export function register_payment_method(use_payment_terminal, ImplementedPaymentInterface) {
    PosStore.prototype.electronic_payment_interfaces[use_payment_terminal] =
        ImplementedPaymentInterface;
}

export const posService = {
    dependencies: PosStore.serviceDependencies,
    async start(env, deps) {
        return new PosStore(env, deps).ready;
    },
};

registry.category("services").add("pos", posService);
