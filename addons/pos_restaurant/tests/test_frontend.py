# -*- coding: utf-8 -*-
# Part of Odoo. See LICENSE file for full copyright and licensing details.

import odoo.tests
from odoo.addons.point_of_sale.tests.common_setup_methods import setup_product_combo_items
from odoo.addons.point_of_sale.tests.common import archive_products
from odoo.addons.point_of_sale.tests.test_frontend import TestPointOfSaleHttpCommon
from odoo import Command
from unittest.mock import patch

@odoo.tests.tagged('post_install', '-at_install')
class TestFrontendCommon(TestPointOfSaleHttpCommon):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        archive_products(cls.env)

        food_category = cls.env['pos.category'].create({'name': 'Food', 'sequence': 1})
        drinks_category = cls.env['pos.category'].create({'name': 'Drinks', 'sequence': 2})

        printer = cls.env['pos.printer'].create({
            'name': 'Preparation Printer',
            'epson_printer_ip': '127.0.0.1',
            'printer_type': 'epson_epos',
            'product_categories_ids': [drinks_category.id]
        })

        main_company = cls.env.company
        test_sale_journal_2 = cls.env['account.journal'].create({
            'name': 'Sales Journal - Test2',
            'code': 'TSJ2',
            'type': 'sale',
            'company_id': main_company.id
            })
        cash_journal_2 = cls.env['account.journal'].create({
            'name': 'Cash 2',
            'type': 'cash',
            'company_id': main_company.id,
        })
        cls.pos_config = cls.env['pos.config'].create({
            'name': 'Bar Prout',
            'module_pos_restaurant': True,
            'iface_splitbill': True,
            'iface_printbill': True,
            'is_order_printer': True,
            'printer_ids': [(4, printer.id)],
            'iface_tipproduct': False,
            'company_id': cls.env.company.id,
            'journal_id': test_sale_journal_2.id,
            'invoice_journal_id': test_sale_journal_2.id,
            'payment_method_ids': [
                (4, cls.bank_payment_method.id),
                (0, 0, {
                    'name': 'Cash',
                    'split_transactions': False,
                    'receivable_account_id': cls.account_receivable.id,
                    'journal_id': cash_journal_2.id,
                })
            ],
        })
        cls.main_pos_config = cls.pos_config

        cls.pos_config.floor_ids.unlink()

        main_floor = cls.env['restaurant.floor'].create({
            'name': 'Main Floor',
            'pos_config_ids': [(4, cls.pos_config.id)],
        })
        second_floor = cls.env['restaurant.floor'].create({
            'name': 'Second Floor',
            'pos_config_ids': [(4, cls.pos_config.id)],
        })

        cls.main_floor_table_5 = cls.env['restaurant.table'].create([{
            'table_number': 5,
            'floor_id': main_floor.id,
            'seats': 4,
            'position_h': 100,
            'position_v': 100,
        }])
        cls.env['restaurant.table'].create([{
            'table_number': 4,
            'floor_id': main_floor.id,
            'seats': 4,
            'shape': 'square',
            'position_h': 350,
            'position_v': 100,
        },
        {
            'table_number': 2,
            'floor_id': main_floor.id,
            'seats': 4,
            'position_h': 250,
            'position_v': 100,
        },
        {

            'table_number': 1,
            'floor_id': second_floor.id,
            'seats': 4,
            'shape': 'square',
            'position_h': 100,
            'position_v': 150,
        },
        {
            'table_number': 3,
            'floor_id': second_floor.id,
            'seats': 4,
            'position_h': 100,
            'position_v': 250,
        }])

        cls.env['ir.default'].set(
            'res.partner',
            'property_account_receivable_id',
            cls.account_receivable.id,
            company_id=main_company.id,
        )

        cls.env['product.product'].create({
            'available_in_pos': True,
            'list_price': 2.20,
            'name': 'Coca-Cola',
            'weight': 0.01,
            'pos_categ_ids': [(4, drinks_category.id)],
            'categ_id': cls.env.ref('point_of_sale.product_category_pos').id,
            'taxes_id': [(6, 0, [])],
        })

        cls.env['product.product'].create({
            'available_in_pos': True,
            'list_price': 2.20,
            'name': 'Water',
            'weight': 0.01,
            'pos_categ_ids': [(4, drinks_category.id)],
            'categ_id': cls.env.ref('point_of_sale.product_category_pos').id,
            'taxes_id': [(6, 0, [])],
        })

        cls.env['product.product'].create({
            'available_in_pos': True,
            'list_price': 2.20,
            'name': 'Minute Maid',
            'weight': 0.01,
            'pos_categ_ids': [(4, drinks_category.id)],
            'categ_id': cls.env.ref('point_of_sale.product_category_pos').id,
            'taxes_id': [(6, 0, [])],
        })

        # multiple categories product
        cls.env['product.product'].create({
            'available_in_pos': True,
            'list_price': 2.20,
            'name': 'Test Multi Category Product',
            'weight': 0.01,
            'pos_categ_ids': [(4, drinks_category.id), (4, food_category.id)],
            'categ_id': cls.env.ref('point_of_sale.product_category_pos').id,
            'taxes_id': [(6, 0, [])],
        })

        # desk organizer (variant product)
        cls.desk_organizer = cls.env['product.product'].create({
            'name': 'Desk Organizer',
            'available_in_pos': True,
            'list_price': 5.10,
            'pos_categ_ids': [(4, drinks_category.id)],  # will put it as a drink for convenience
        })
        desk_size_attribute = cls.env['product.attribute'].create({
            'name': 'Size',
            'display_type': 'radio',
            'create_variant': 'no_variant',
        })
        desk_size_s = cls.env['product.attribute.value'].create({
            'name': 'S',
            'attribute_id': desk_size_attribute.id,
        })
        desk_size_m = cls.env['product.attribute.value'].create({
            'name': 'M',
            'attribute_id': desk_size_attribute.id,
        })
        desk_size_l = cls.env['product.attribute.value'].create({
            'name': 'L',
            'attribute_id': desk_size_attribute.id,
        })
        cls.env['product.template.attribute.line'].create({
            'product_tmpl_id': cls.desk_organizer.product_tmpl_id.id,
            'attribute_id': desk_size_attribute.id,
            'value_ids': [(6, 0, [desk_size_s.id, desk_size_m.id, desk_size_l.id])]
        })
        desk_fabrics_attribute = cls.env['product.attribute'].create({
            'name': 'Fabric',
            'display_type': 'select',
            'create_variant': 'no_variant',
        })
        desk_fabrics_leather = cls.env['product.attribute.value'].create({
            'name': 'Leather',
            'attribute_id': desk_fabrics_attribute.id,
        })
        desk_fabrics_other = cls.env['product.attribute.value'].create({
            'name': 'Custom',
            'attribute_id': desk_fabrics_attribute.id,
            'is_custom': True,
        })
        cls.env['product.template.attribute.line'].create({
            'product_tmpl_id': cls.desk_organizer.product_tmpl_id.id,
            'attribute_id': desk_fabrics_attribute.id,
            'value_ids': [(6, 0, [desk_fabrics_leather.id, desk_fabrics_other.id])]
        })

        pricelist = cls.env['product.pricelist'].create({'name': 'Restaurant Pricelist'})
        cls.pos_config.write({'pricelist_id': pricelist.id})


class TestFrontend(TestFrontendCommon):

    def test_01_pos_restaurant(self):
        self.pos_user.write({
            'groups_id': [
                (4, self.env.ref('account.group_account_invoice').id),
            ]
        })
        dummy_fiscal_position = self.env['account.fiscal.position'].create({
            'name': 'No Tax',
        })
        self.pos_config.write({
            'takeaway': True,
            'takeaway_fp_id': dummy_fiscal_position.id,
        })
        self.pos_config.with_user(self.pos_user).open_ui()

        self.start_pos_tour('pos_restaurant_sync')

        self.assertEqual(1, self.env['pos.order'].search_count([('amount_total', '=', 4.4), ('state', '=', 'draft')]))
        self.assertEqual(1, self.env['pos.order'].search_count([('amount_total', '=', 4.4), ('state', '=', 'paid')]))

        self.start_pos_tour('pos_restaurant_sync_second_login')

        self.assertEqual(0, self.env['pos.order'].search_count([('amount_total', '=', 4.4), ('state', '=', 'draft')]))
        self.assertEqual(1, self.env['pos.order'].search_count([('amount_total', '=', 2.2), ('state', '=', 'draft')]))
        self.assertEqual(2, self.env['pos.order'].search_count([('amount_total', '=', 4.4), ('state', '=', 'paid')]))

    def test_02_others(self):
        self.pos_config.with_user(self.pos_user).open_ui()
        self.start_pos_tour('SplitBillScreenTour')
        self.start_pos_tour('FloorScreenTour', login="pos_admin")

    def test_02_others_bis(self):
        self.pos_config.with_user(self.pos_admin).open_ui()
        self.start_pos_tour('ControlButtonsTour', login="pos_admin")

    def test_04_ticket_screen(self):
        self.pos_config.with_user(self.pos_user).open_ui()
        self.start_pos_tour('PosResTicketScreenTour')

    def test_05_tip_screen(self):
        self.pos_config.write({'set_tip_after_payment': True, 'iface_tipproduct': True, 'tip_product_id': self.env.ref('point_of_sale.product_product_tip')})
        self.pos_config.with_user(self.pos_user).open_ui()
        self.start_pos_tour('PosResTipScreenTour')

        orders = self.env['pos.order'].search([], limit=5, order="id desc")
        order_tips = [o.tip_amount for o in orders]

        # orders order can be different depending on which module is install so we sort the tips
        order_tips.sort()
        self.assertEqual(order_tips, [0.0, 0.4, 1.0, 1.0, 1.5])

        order1 = self.env['pos.order'].search([('pos_reference', 'ilike', '%-0001')], limit=1, order='id desc')
        self.assertEqual(order1.payment_ids.amount, 2.4)

        order4 = self.env['pos.order'].search([('pos_reference', 'ilike', '%-0004')], limit=1, order='id desc')
        self.assertEqual(order4.customer_count, 2)

    def test_06_split_bill_screen(self):
        self.pos_config.with_user(self.pos_user).open_ui()
        self.start_pos_tour('SplitBillScreenTour2')

    def test_07_split_bill_screen(self):
        # disable kitchen printer to avoid printing errors
        self.pos_config.is_order_printer = False
        self.pos_config.with_user(self.pos_user).open_ui()
        self.start_pos_tour('SplitBillScreenTour3')

    def test_08_refund_stay_current_table(self):
        self.pos_config.with_user(self.pos_user).open_ui()
        self.start_pos_tour('RefundStayCurrentTableTour')

    def test_09_combo_split_bill(self):
        setup_product_combo_items(self)
        self.office_combo.write({'lst_price': 40})
        self.pos_config.is_order_printer = False
        self.pos_config.with_user(self.pos_user).open_ui()
        self.start_pos_tour('SplitBillScreenTour4ProductCombo')

    def test_10_save_last_preparation_changes(self):
        self.pos_config.write({'printer_ids': False})
        self.pos_config.with_user(self.pos_user).open_ui()
        self.start_pos_tour('SaveLastPreparationChangesTour')
        self.assertTrue(self.pos_config.current_session_id.order_ids.last_order_preparation_change, "There should be a last order preparation change")
        self.assertTrue("Coca" in self.pos_config.current_session_id.order_ids.last_order_preparation_change, "The last order preparation change should contain 'Coca'")

    def test_11_bill_screen_qrcode_data(self):
        self.pos_config.write({'printer_ids': False})
        self.pos_config.company_id.point_of_sale_use_ticket_qr_code = True
        self.pos_config.company_id.point_of_sale_ticket_portal_url_display_mode = 'qr_code_and_url'
        self.pos_config.with_user(self.pos_user).open_ui()
        self.start_pos_tour('BillScreenTour')

    def test_12_order_tracking(self):
        self.pos_config.write({'order_edit_tracking': True})
        self.pos_config.with_user(self.pos_user).open_ui()
        self.start_pos_tour('OrderTrackingTour')
        order1 = self.env['pos.order'].search([('pos_reference', 'ilike', '%-0001')], limit=1, order='id desc')
        self.assertTrue(order1.is_edited)

    def test_13_category_check(self):
        self.pos_config.with_user(self.pos_user).open_ui()
        self.start_pos_tour('CategLabelCheck')

    def test_14_change_synced_order(self):
        self.pos_config.with_user(self.pos_user).open_ui()
        self.start_pos_tour('OrderChange')

    def test_13_crm_team(self):
        if self.env['ir.module.module']._get('pos_sale').state != 'installed':
            self.skipTest("'pos_sale' module is required")
        sale_team = self.env['crm.team'].search([], limit=1)
        self.pos_config.crm_team_id = sale_team
        self.pos_config.with_user(self.pos_user).open_ui()
        self.start_pos_tour('CrmTeamTour')
        order = self.env['pos.order'].search([], limit=1)
        self.assertEqual(order.crm_team_id.id, sale_team.id)

    def test_14_pos_payment_sync(self):
        self.pos_config.write({'printer_ids': False})
        self.pos_config.with_user(self.pos_user).open_ui()
        def assert_payment(lines_count, amount):
            self.assertEqual(len(order.payment_ids), lines_count)
            self.assertEqual(round(sum(payment.amount for payment in order.payment_ids), 2), amount)
        self.start_pos_tour('PoSPaymentSyncTour1')
        order = self.pos_config.current_session_id.order_ids
        self.assertEqual(len(order), 1)
        assert_payment(1, 2.2)
        self.start_pos_tour('PoSPaymentSyncTour2')
        assert_payment(1, 4.4)
        self.start_pos_tour('PoSPaymentSyncTour3')
        assert_payment(2, 6.6)

    def test_preparation_printer_content(self):
        self.env['pos.printer'].create({
            'name': 'Printer',
            'printer_type': 'epson_epos',
            'epson_printer_ip': '0.0.0.0',
            'product_categories_ids': [Command.set(self.env['pos.category'].search([]).ids)],
        })

        self.main_pos_config.write({
            'is_order_printer' : True,
            'printer_ids': [Command.set(self.env['pos.printer'].search([]).ids)],
        })

        self.product_test = self.env['product.product'].create({
            'name': 'Product Test',
            'available_in_pos': True,
            'list_price': 10,
            'pos_categ_ids': [(6, 0, [self.env['pos.category'].search([], limit=1).id])],
            'taxes_id': False,
        })

        attribute = self.env['product.attribute'].create({
            'name': 'Attribute 1',
            'create_variant': 'no_variant',
        })
        attribute_value = self.env['product.attribute.value'].create({
            'name': 'Value 1',
            'attribute_id': attribute.id,
        })
        attribute_value_2 = self.env['product.attribute.value'].create({
            'name': 'Value 2',
            'attribute_id': attribute.id,
        })
        self.env['product.template.attribute.line'].create({
            'product_tmpl_id': self.product_test.product_tmpl_id.id,
            'attribute_id': attribute.id,
            'value_ids': [(6, 0, [attribute_value.id, attribute_value_2.id])],
        })

        attribute_2 = self.env['product.attribute'].create({
            'name': 'Attribute 1',
            'create_variant': 'always',
        })
        attribute_2_value = self.env['product.attribute.value'].create({
            'name': 'Value 1',
            'attribute_id': attribute_2.id,
        })
        attribute_2_value_2 = self.env['product.attribute.value'].create({
            'name': 'Value 2',
            'attribute_id': attribute_2.id,
        })
        self.env['product.template.attribute.line'].create({
            'product_tmpl_id': self.product_test.product_tmpl_id.id,
            'attribute_id': attribute_2.id,
            'value_ids': [(6, 0, [attribute_2_value.id, attribute_2_value_2.id])],
        })
        self.main_pos_config.with_user(self.pos_user).open_ui()
        self.start_tour(f"/pos/ui?config_id={self.main_pos_config.id}", 'PreparationPrinterContent', login="pos_user")

    def test_transfer_table_last_preparation_change(self):
        """This test will check if the last preparation change is correctly transferred to the new table with 6 possible cases:
            - Transfer sent product on table with same product sent
            - Transfer sent product on table with same product not sent
            - Transfer sent product on table without the same product
            - Transfer not sent product on table with same product not sent
            - Transfer not sent product on table with same product sent
            - Transfer not sent product on table without the same product"""
        self.env['pos.printer'].create({
            'name': 'Printer',
            'printer_type': 'epson_epos',
            'epson_printer_ip': '0.0.0.0',
            'product_categories_ids': [Command.set(self.env['pos.category'].search([]).ids)],
        })

        self.main_pos_config.write({
            'is_order_printer' : True,
            'printer_ids': [Command.set(self.env['pos.printer'].search([]).ids)],
        })

        self.product_test = self.env['product.product'].create({
            'name': 'Product Test',
            'available_in_pos': True,
            'list_price': 10,
            'pos_categ_ids': [(6, 0, [self.env['pos.category'].search([], limit=1).id])],
            'taxes_id': False,
        })

        self.main_pos_config.with_user(self.pos_user).open_ui()
        self.start_tour(f"/pos/ui?config_id={self.main_pos_config.id}", 'TableTransferPreparationChange1', login="pos_user")
        self.start_tour(f"/pos/ui?config_id={self.main_pos_config.id}", 'TableTransferPreparationChange2', login="pos_user")
        self.start_tour(f"/pos/ui?config_id={self.main_pos_config.id}", 'TableTransferPreparationChange3', login="pos_user")
        self.start_tour(f"/pos/ui?config_id={self.main_pos_config.id}", 'TableTransferPreparationChange4', login="pos_user")
        self.start_tour(f"/pos/ui?config_id={self.main_pos_config.id}", 'TableTransferPreparationChange5', login="pos_user")
        self.start_tour(f"/pos/ui?config_id={self.main_pos_config.id}", 'TableTransferPreparationChange6', login="pos_user")

    def test_combo_preparation_receipt(self):
        setup_product_combo_items(self)
        pos_printer = self.env['pos.printer'].create({
            'name': 'Printer',
            'printer_type': 'epson_epos',
            'epson_printer_ip': '0.0.0.0',
            'product_categories_ids': [Command.set(self.env['pos.category'].search([]).ids)],
        })
        self.pos_config.write({
            'is_order_printer' : True,
            'printer_ids': [Command.set(pos_printer.ids)],
        })
        self.pos_config.with_user(self.pos_user).open_ui()
        self.start_pos_tour('ComboSortedPreparationReceiptTour')

    def test_multiple_preparation_printer(self):
        """This test make sure that no empty receipt are sent when using multiple printer with different categories
           The tour will check that we tried did not try to print two receipt. We can achieve that by checking the content
           of the error message. Because we do not have real printer an error message will be displayed, this will contain
           all the receipt that failed to print. If it contains more than 1 it means that we tried to print a second receipt
           and it should not be the case here. The only one we should see is 'Detailed Receipt'
        """
        pos_category_1 = self.env['pos.category'].create({'name': 'Category 1'})
        pos_category_2 = self.env['pos.category'].create({'name': 'Category 2'})
        printer_1 = self.env['pos.printer'].create({
            'name': 'Printer',
            'printer_type': 'epson_epos',
            'epson_printer_ip': '0.0.0.0',
            'product_categories_ids': [Command.set(pos_category_2.ids)],
        })
        printer_2 = self.env['pos.printer'].create({
            'name': 'Printer',
            'printer_type': 'epson_epos',
            'epson_printer_ip': '0.0.0.0',
            'product_categories_ids': [Command.set(pos_category_1.ids)],
        })


        self.main_pos_config.write({
            'is_order_printer' : True,
            'printer_ids': [Command.set([printer_1.id, printer_2.id])],
        })

        self.product_1 = self.env['product.product'].create({
            'name': 'Product 1',
            'available_in_pos': True,
            'list_price': 10,
            'pos_categ_ids': [(6, 0, [pos_category_1.id])],
            'taxes_id': False,
        })

        self.main_pos_config.with_user(self.pos_user).open_ui()
        self.start_tour(f"/pos/ui?config_id={self.main_pos_config.id}", 'MultiPreparationPrinter', login="pos_user")

    def test_user_on_residual_order(self):
        self.pos_config.write({'printer_ids': False})
        self.pos_config.with_user(self.pos_admin).open_ui()
        self.start_pos_tour('LeaveResidualOrder', login="pos_admin")
        self.start_pos_tour('FinishResidualOrder', login="pos_user")
        orders = self.env['pos.order'].search([])
        self.assertEqual(orders[0].user_id.id, self.pos_user.id, "Pos user not registered on order")
        self.assertEqual(orders[1].user_id.id, self.pos_admin.id, "Pos admin not registered on order")

    def test_15_pos_refund_qty(self):
        self.pos_config.with_user(self.pos_user).open_ui()
        self.start_pos_tour('RefundQtyTour')

    def test_combo_preparation_receipt_layout(self):
        setup_product_combo_items(self)
        self.env['product.product'].search([('name', 'ilike', 'Combo')]).write({'pos_categ_ids': [(Command.set(self.env['pos.category'].search([], limit=1).ids))]})
        self.env['pos.printer'].create({
            'name': 'Printer',
            'printer_type': 'epson_epos',
            'epson_printer_ip': '0.0.0.0',
            'product_categories_ids': [Command.set(self.env['pos.category'].search([]).ids)],
        })
        self.pos_config.write({
            'is_order_printer': True,
            'printer_ids': [Command.set(self.env['pos.printer'].search([]).ids)],
        })
        self.pos_config.with_user(self.pos_admin).open_ui()
        self.start_tour(f"/pos/ui?config_id={self.pos_config.id}", 'test_combo_preparation_receipt_layout', login="pos_admin")

    def test_synchronisation_of_orders(self):
        """ Test order synchronization with order data using the notify_synchronisation method.
            First, an ongoing order is created on the server, and verify its presence in the POS UI.
            Then, the order is paid from the server, and confirm if the order state is updated correctly.
        """
        self.start_pos_tour("OrderSynchronisationTour")

    def test_book_and_release_table(self):
        self.pos_config.with_user(self.pos_user).open_ui()
        self.start_pos_tour('test_book_and_release_table', login="pos_user")
        order = self.env['pos.order'].search([], limit=1, order='id desc')
        self.assertEqual(order.state, "cancel", "The order should be in cancel state after releasing the table")
