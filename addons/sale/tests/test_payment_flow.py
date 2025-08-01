# Part of Odoo. See LICENSE file for full copyright and licensing details.

from unittest.mock import patch

from odoo.exceptions import AccessError
from odoo.tests import JsonRpcException, tagged
from odoo.tools import mute_logger

from odoo.addons.account_payment.tests.common import AccountPaymentCommon
from odoo.addons.mail.tests.common import MailCase
from odoo.addons.payment.tests.http_common import PaymentHttpCommon
from odoo.addons.portal.controllers.portal import CustomerPortal
from odoo.addons.sale.controllers.portal import PaymentPortal
from odoo.addons.sale.tests.common import SaleCommon


@tagged('-at_install', 'post_install')
class TestSalePayment(AccountPaymentCommon, SaleCommon, PaymentHttpCommon, MailCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()

        # Replace PaymentCommon defaults by SaleCommon ones
        cls.currency = cls.sale_order.currency_id
        cls.partner = cls.sale_order.partner_invoice_id

        cls.provider.journal_id.inbound_payment_method_line_ids.filtered(lambda l:
            l.payment_provider_id == cls.provider
        ).payment_account_id = cls.inbound_payment_method_line.payment_account_id

    def test_11_so_payment_link(self):
        # test customized /payment/pay route with sale_order_id param
        self.amount = self.sale_order.amount_total
        route_values = self._prepare_pay_values()
        route_values['sale_order_id'] = self.sale_order.id

        with patch(
            'odoo.addons.payment.controllers.portal.PaymentPortal'
            '._compute_show_tokenize_input_mapping'
        ) as patched:
            tx_context = self._get_portal_pay_context(**route_values)
            patched.assert_called_once()
            self.assertIn('sale_order_id', patched.call_args[1])

        self.assertEqual(tx_context['currency_id'], self.sale_order.currency_id.id)
        self.assertEqual(tx_context['partner_id'], self.sale_order.partner_invoice_id.id)
        self.assertEqual(tx_context['amount'], self.sale_order.amount_total)

        # /my/orders/<id>/transaction/
        tx_route_values = {
            'provider_id': self.provider.id,
            'payment_method_id': self.payment_method_id,
            'token_id': None,
            'amount': tx_context['amount'],
            'flow': 'direct',
            'tokenization_requested': False,
            'landing_route': tx_context['landing_route'],
            'access_token': tx_context['access_token'],
        }
        with mute_logger('odoo.addons.payment.models.payment_transaction'):
            processing_values = self._get_processing_values(
                tx_route=tx_context['transaction_route'], **tx_route_values
            )
        tx_sudo = self._get_tx(processing_values['reference'])

        self.assertEqual(tx_sudo.sale_order_ids, self.sale_order)
        self.assertEqual(tx_sudo.amount, self.amount)
        self.assertEqual(tx_sudo.partner_id, self.sale_order.partner_invoice_id)
        self.assertEqual(tx_sudo.company_id, self.sale_order.company_id)
        self.assertEqual(tx_sudo.currency_id, self.sale_order.currency_id)
        self.assertEqual(tx_sudo.reference, self.sale_order.name)

        # Check validation of transaction correctly confirms the SO
        self.assertEqual(self.sale_order.state, 'draft')
        self.assertEqual(tx_sudo.sale_order_ids.transaction_ids, tx_sudo)
        tx_sudo._set_done()
        tx_sudo._post_process()
        self.assertEqual(self.sale_order.state, 'sale')
        self.assertTrue(tx_sudo.payment_id)
        self.assertEqual(tx_sudo.payment_id.state, 'in_process')

    def test_so_payment_link_with_different_partner_invoice(self):
        # test customized /payment/pay route with sale_order_id param
        # partner_id and partner_invoice_id different on the so
        self.sale_order.partner_invoice_id = self.portal_partner
        self.partner = self.sale_order.partner_invoice_id
        route_values = self._prepare_pay_values()
        route_values['sale_order_id'] = self.sale_order.id

        tx_context = self._get_portal_pay_context(**route_values)
        self.assertEqual(tx_context['partner_id'], self.sale_order.partner_invoice_id.id)

    def test_12_so_partial_payment_link(self):
        # test customized /payment/pay route with sale_order_id param
        # partial amount specified
        self.amount = self.sale_order.amount_total / 2.0
        pay_route_values = self._prepare_pay_values()
        pay_route_values['sale_order_id'] = self.sale_order.id

        tx_context = self._get_portal_pay_context(**pay_route_values)

        self.assertEqual(tx_context['currency_id'], self.sale_order.currency_id.id)
        self.assertEqual(tx_context['partner_id'], self.sale_order.partner_invoice_id.id)
        self.assertEqual(tx_context['amount'], self.amount)

        tx_route_values = {
            'provider_id': self.provider.id,
            'payment_method_id': self.payment_method_id,
            'token_id': None,
            'amount': tx_context['amount'],
            'flow': 'direct',
            'tokenization_requested': False,
            'landing_route': tx_context['landing_route'],
            'access_token': tx_context['access_token'],
        }
        with mute_logger('odoo.addons.payment.models.payment_transaction'):
            processing_values = self._get_processing_values(
                tx_route=tx_context['transaction_route'], **tx_route_values
            )
        tx_sudo = self._get_tx(processing_values['reference'])

        self.assertEqual(tx_sudo.sale_order_ids, self.sale_order)
        self.assertEqual(tx_sudo.amount, self.amount)
        self.assertEqual(tx_sudo.partner_id, self.sale_order.partner_invoice_id)
        self.assertEqual(tx_sudo.company_id, self.sale_order.company_id)
        self.assertEqual(tx_sudo.currency_id, self.sale_order.currency_id)
        self.assertEqual(tx_sudo.sale_order_ids.transaction_ids, tx_sudo)

        tx_sudo._set_done()

        self.sale_order.require_payment = True
        self.assertTrue(self.sale_order._has_to_be_paid())
        with mute_logger('odoo.addons.sale.models.payment_transaction'):
            tx_sudo._post_process()
        self.assertEqual(self.sale_order.state, 'draft') # Only a partial amount was paid

        # Pay the remaining amount
        pay_route_values = self._prepare_pay_values()
        pay_route_values['sale_order_id'] = self.sale_order.id

        tx_context = self._get_portal_pay_context(**pay_route_values)

        self.assertEqual(tx_context['currency_id'], self.sale_order.currency_id.id)
        self.assertEqual(tx_context['partner_id'], self.sale_order.partner_invoice_id.id)
        self.assertEqual(tx_context['amount'], self.amount)

        tx_route_values = {
            'provider_id': self.provider.id,
            'payment_method_id': self.payment_method_id,
            'token_id': None,
            'amount': tx_context['amount'],
            'flow': 'direct',
            'tokenization_requested': False,
            'landing_route': tx_context['landing_route'],
            'access_token': tx_context['access_token'],
        }
        with mute_logger('odoo.addons.payment.models.payment_transaction'):
            processing_values = self._get_processing_values(
                tx_route=tx_context['transaction_route'], **tx_route_values
            )
        tx2_sudo = self._get_tx(processing_values['reference'])

        self.assertEqual(tx2_sudo.sale_order_ids, self.sale_order)
        self.assertEqual(tx2_sudo.amount, self.amount)
        self.assertEqual(tx2_sudo.partner_id, self.sale_order.partner_invoice_id)
        self.assertEqual(tx2_sudo.company_id, self.sale_order.company_id)
        self.assertEqual(tx2_sudo.currency_id, self.sale_order.currency_id)

        self.assertEqual(self.sale_order.state, 'draft')
        self.assertEqual(self.sale_order.transaction_ids, tx_sudo + tx2_sudo)

    def test_13_sale_automatic_partial_payment_link_delivery(self):
        """Test that with automatic invoice and invoicing policy based on delivered quantity, a transaction for the partial
        amount does not validate the SO."""
        # set automatic invoice
        self.env['ir.config_parameter'].sudo().set_param('sale.automatic_invoice', 'True')
        # invoicing policy is based on delivered quantity
        self.product.invoice_policy = 'delivery'

        self.amount = self.sale_order.amount_total / 2.0
        pay_route_values = self._prepare_pay_values()
        pay_route_values['sale_order_id'] = self.sale_order.id

        tx_context = self._get_portal_pay_context(**pay_route_values)

        tx_route_values = {
            'provider_id': self.provider.id,
            'payment_method_id': self.payment_method_id,
            'token_id': None,
            'amount': tx_context['amount'],
            'flow': 'direct',
            'tokenization_requested': False,
            'landing_route': tx_context['landing_route'],
            'access_token': tx_context['access_token'],
        }
        with mute_logger('odoo.addons.payment.models.payment_transaction'):
            processing_values = self._get_processing_values(
                tx_route=tx_context['transaction_route'], **tx_route_values
            )
        tx_sudo = self._get_tx(processing_values['reference'])

        tx_sudo._set_done()
        with mute_logger('odoo.addons.sale.models.payment_transaction'):
            tx_sudo._post_process()

        self.assertEqual(self.sale_order.state, 'draft', 'a partial transaction with automatic invoice and invoice_policy = delivery should not validate a quote')

    def test_confirmed_transactions_comfirms_so_with_multiple_transaction(self):
        """ Test that a confirmed transaction confirms a SO even if one or more non-confirmed
        transactions are linked. """
        # Create the payment
        self.amount = self.sale_order.amount_total
        self._create_transaction(
            flow='redirect',
            sale_order_ids=[self.sale_order.id],
            state='draft',
            reference='Test Transaction Draft 1',
        )
        self._create_transaction(
            flow='redirect',
            sale_order_ids=[self.sale_order.id],
            state='draft',
            reference='Test Transaction Draft 2',
        )
        tx = self._create_transaction(flow='redirect', sale_order_ids=[self.sale_order.id], state='done')
        tx._post_process()

        self.assertEqual(self.sale_order.state, 'sale')

    def test_auto_confirm_and_auto_invoice(self):
        """
        Assuming that the automatic invoice setting is activated, we expect
        that after the payment is post processed:
        - invoice created
        - SO confirmed
        - Two emails sent: SO confirmation and default invoice email template
        """
        # Set automatic invoice
        self.env['ir.config_parameter'].sudo().set_param('sale.automatic_invoice', 'True')

        # Create the payment
        self.amount = self.sale_order.amount_total
        tx = self._create_transaction(flow='redirect', sale_order_ids=[self.sale_order.id], state='done')
        with (
            mute_logger('odoo.addons.sale.models.payment_transaction'),
            self.mock_mail_gateway(),
        ):
            tx._post_process()

        self.assertEqual(self.sale_order.state, 'sale')
        self.assertTrue(tx.invoice_ids)
        self.assertTrue(self.sale_order.invoice_ids)
        self.assertEqual(len(self._new_mails), 2)
        self.assertTrue(self._new_mails.filtered(lambda x: 'Invoice' in x.subject))

    def test_auto_confirm_and_auto_invoice_custom_mail_template(self):
        """
        Assuming that the automatic invoice setting is activated and a custom
        email template for invoicing was selected, we expect that after the
        payment is post processed:
        - invoice created
        - SO confirmed
        - Two emails sent: SO confirmation and invoice email using the custom template
        """
        # Set automatic invoice
        self.env['ir.config_parameter'].sudo().set_param('sale.automatic_invoice', 'True')
        custom_template = self.env['mail.template'].create({
            'name': 'Custom Test Invoice Template',
            'model_id': self.env.ref('account.model_account_move').id,
            'subject': 'Your Custom Template',
            'partner_to': '{{ object.partner_id.id }}',
        })
        self.env['ir.config_parameter'].set_param('sale.default_invoice_email_template', custom_template.id)

        # Create the payment
        self.amount = self.sale_order.amount_total
        tx = self._create_transaction(flow='redirect', sale_order_ids=[self.sale_order.id], state='done')
        with (
            mute_logger('odoo.addons.sale.models.payment_transaction'),
            self.mock_mail_gateway(),
        ):
            tx._post_process()

        self.assertEqual(self.sale_order.state, 'sale')
        self.assertTrue(tx.invoice_ids)
        self.assertTrue(self.sale_order.invoice_ids)
        self.assertEqual(len(self._new_mails), 2)
        self.assertTrue(self._new_mails.filtered(lambda x: 'Your Custom Template' in x.subject))

    def test_auto_confirm_and_auto_invoice_custom_mail_template_unlinked(self):
        """
        Assuming that the automatic invoice setting is activated and a custom
        email template for invoicing was selected. If the custom email template
        gets unlinked, the system parameter still stores the id, but code
        should fall back to default invoice email template. We expect that after the
        payment is post processed:
        - invoice created
        - SO confirmed
        - Two emails sent: SO confirmation and invoice email using the DEFAULT template
        """
        # Set automatic invoice
        self.env['ir.config_parameter'].sudo().set_param('sale.automatic_invoice', 'True')
        custom_template = self.env['mail.template'].create({
            'name': 'Custom Test Invoice Template',
            'model_id': self.env.ref('account.model_account_move').id,
            'subject': 'Your Custom Template',
            'partner_to': '{{ object.partner_id.id }}',
        })
        self.env['ir.config_parameter'].set_param('sale.default_invoice_email_template', custom_template.id)
        custom_template.unlink()

        # Create the payment
        self.amount = self.sale_order.amount_total
        tx = self._create_transaction(flow='redirect', sale_order_ids=[self.sale_order.id], state='done')
        with (
            mute_logger('odoo.addons.sale.models.payment_transaction'),
            self.mock_mail_gateway(),
        ):
            tx._post_process()

        self.assertEqual(self.sale_order.state, 'sale')
        self.assertTrue(tx.invoice_ids)
        self.assertTrue(self.sale_order.invoice_ids)
        self.assertEqual(len(self._new_mails), 2)
        self.assertTrue(self._new_mails.filtered(lambda x: 'Invoice' in x.subject))

    def test_auto_done_and_auto_invoice(self):
        # Set automatic invoice
        self.env['ir.config_parameter'].sudo().set_param('sale.automatic_invoice', 'True')
        # Lock the sale orders when confirmed
        self.env.user.groups_id += self.env.ref('sale.group_auto_done_setting')

        # Create the payment
        self.amount = self.sale_order.amount_total
        tx = self._create_transaction(flow='redirect', sale_order_ids=[self.sale_order.id], state='done')
        with mute_logger('odoo.addons.sale.models.payment_transaction'):
            tx._post_process()

        self.assertEqual(self.sale_order.state, 'sale')
        self.assertTrue(self.sale_order.locked)
        self.assertTrue(tx.invoice_ids)
        self.assertTrue(self.sale_order.invoice_ids)
        self.assertTrue(tx.invoice_ids.is_move_sent)

    def test_so_partial_payment_no_invoice(self):
        # Set automatic invoice
        self.env['ir.config_parameter'].sudo().set_param('sale.automatic_invoice', 'True')

        # Create the payment
        self.amount = self.sale_order.amount_total / 10.
        tx = self._create_transaction(flow='redirect', sale_order_ids=[self.sale_order.id], state='done')
        with mute_logger('odoo.addons.sale.models.payment_transaction'):
            tx._post_process()

        self.assertEqual(self.sale_order.state, 'draft')
        self.assertFalse(tx.invoice_ids)
        self.assertFalse(self.sale_order.invoice_ids)

    def test_already_confirmed_so_payment(self):
        # Set automatic invoice
        self.env['ir.config_parameter'].sudo().set_param('sale.automatic_invoice', 'True')

        # Confirm order before payment
        self.sale_order.action_confirm()

        # Create the payment
        self.amount = self.sale_order.amount_total
        tx = self._create_transaction(flow='redirect', sale_order_ids=[self.sale_order.id], state='done')
        tx._post_process()

        self.assertTrue(tx.invoice_ids)
        self.assertTrue(self.sale_order.invoice_ids)

    def test_invoice_is_final(self):
        """Test that invoice generated from a payment are always final"""
        # Set automatic invoice
        self.env['ir.config_parameter'].sudo().set_param('sale.automatic_invoice', 'True')

        # Create the payment
        self.amount = self.sale_order.amount_total
        tx = self._create_transaction(
            flow='redirect',
            sale_order_ids=[self.sale_order.id],
            state='done',
        )
        with mute_logger('odoo.addons.sale.models.payment_transaction'), patch(
            'odoo.addons.sale.models.sale_order.SaleOrder._create_invoices',
            return_value=self.env['account.move']
        ) as _create_invoices_mock:
            tx._post_process()

        self.assertTrue(_create_invoices_mock.call_args.kwargs['final'])

    def test_linked_transactions_when_invoicing(self):
        self.provider.support_manual_capture = 'partial'
        partial_amount = self.sale_order.amount_total - 2

        partial_tx_done = self._create_transaction(
            flow='direct',
            amount=partial_amount,
            sale_order_ids=[self.sale_order.id],
            state='done',
            reference='partial_tx_done',
        )
        with mute_logger('odoo.addons.sale.models.payment_transaction'):
            partial_tx_done._post_process()
        partial_tx_pending = self._create_transaction(
            flow='direct',
            amount=2,
            sale_order_ids=[self.sale_order.id],
            state='pending',
            reference='partial_tx_pending',
        )
        self.assertTrue(partial_tx_done.payment_id, msg="Account payment should have been created.")
        msg = "The created account payment shouldn't be reconciled as there are no invoice yet."
        self.assertFalse(partial_tx_pending.payment_id.is_reconciled, msg=msg)

        # Add some noisy transactions
        self._create_transaction(
            flow='direct', sale_order_ids=[self.sale_order.id], state='draft', reference='draft_tx'
        )
        self._create_transaction(
            flow='direct', sale_order_ids=[self.sale_order.id], state='error', reference='error_tx'
        )
        self._create_transaction(
            flow='direct', sale_order_ids=[self.sale_order.id], state='cancel', reference='cncl_tx'
        )

        msg = "The sale order should be linked to 5 transactions."
        self.assertEqual(len(self.sale_order.transaction_ids), 5, msg=msg)

        self.sale_order.action_confirm()
        self.sale_order._create_invoices()

        self.assertEqual(len(self.sale_order.invoice_ids), 1, msg="1 invoice should be created.")

        first_invoice = self.sale_order.invoice_ids
        linked_txs = first_invoice.transaction_ids
        msg = "The newly created invoice should be linked to the done and pending transactions."
        self.assertEqual(len(linked_txs), 2, msg=msg)
        expected_linked_tx = (partial_tx_done, partial_tx_pending)
        self.assertTrue(all(tx in expected_linked_tx for tx in linked_txs), msg=msg)
        msg = "The payment shouldn't be reconciled yet."
        self.assertFalse(partial_tx_done.payment_id.is_reconciled, msg=msg)

        partial_tx_done._post_process()

        msg = "The payment should now be reconciled."
        self.assertTrue(partial_tx_done.payment_id.is_reconciled, msg=msg)

        self.sale_order.order_line[0].product_uom_qty += 2
        self.sale_order._create_invoices()

        second_invoice = self.sale_order.invoice_ids - first_invoice
        msg = "The newly created invoice should only be linked to the pending transaction."
        self.assertEqual(len(second_invoice.transaction_ids), 1, msg=msg)
        self.assertEqual(second_invoice.transaction_ids.state, 'pending', msg=msg)

    def test_downpayment_confirm_sale_order_sufficient_amount(self):
        """Paying down payments can confirm an order if amount is enough."""
        self.sale_order.require_payment = True
        self.sale_order.prepayment_percent = 0.1
        order_amount = self.sale_order.amount_total

        tx = self._create_transaction(
            flow='direct',
            amount=order_amount * self.sale_order.prepayment_percent,
            sale_order_ids=[self.sale_order.id],
            state='done',
        )
        with mute_logger('odoo.addons.sale.models.payment_transaction'):
            tx._post_process()

        self.assertTrue(self.sale_order.state == 'sale')

    def test_downpayment_confirm_sale_order_insufficient_amount(self):
        """Confirmation cannot occur if amount is not enough."""

        self.sale_order.require_payment = True
        self.sale_order.prepayment_percent = 0.2
        order_amount = self.sale_order.amount_total

        tx = self._create_transaction(
            flow='direct',
            amount=order_amount * 0.10,
            sale_order_ids=[self.sale_order.id],
            state='done',
        )
        with mute_logger('odoo.addons.sale.models.payment_transaction'):
            tx._post_process()

        self.assertTrue(self.sale_order.state == 'draft')

    def test_downpayment_confirm_sale_order_several_payments(self):
        """
        Several payments also trigger the confirmation of the sale order if
        down payment confirmation is allowed.
        """
        self.sale_order.require_payment = True
        self.sale_order.prepayment_percent = 0.2
        order_amount = self.sale_order.amount_total

        # Make a first payment, order should not be confirmed.
        tx = self._create_transaction(
            flow='direct',
            reference="Test down payment 1",
            amount=order_amount * 0.1,
            sale_order_ids=[self.sale_order.id],
            state='done',
        )
        tx._post_process()
        self.assertTrue(self.sale_order.state == 'draft')

        # Order should be confirmed after this payment.
        tx = self._create_transaction(
            flow='direct',
            reference="Test down payment 2",
            amount=order_amount * 0.15,
            sale_order_ids=[self.sale_order.id],
            state='done',
        )
        tx._post_process()
        self.assertTrue(self.sale_order.state == 'sale')

    def test_downpayment_automatic_invoice(self):
        """
        Down payment invoices should be created when a down payment confirms
        the order and automatic invoice is checked.
        """
        self.sale_order.require_payment = True
        self.sale_order.prepayment_percent = 0.2
        self.env['ir.config_parameter'].sudo().set_param('sale.automatic_invoice', 'True')

        tx = self._create_transaction(
            flow='direct',
            amount=self.sale_order.amount_total * self.sale_order.prepayment_percent,
            sale_order_ids=[self.sale_order.id],
            state='done')

        with mute_logger('odoo.addons.sale.models.payment_transaction'):
            tx._post_process()

        invoice = self.sale_order.invoice_ids
        self.assertTrue(len(invoice) == 1)
        self.assertTrue(invoice.line_ids[0].is_downpayment)

    def test_check_portal_access_token_before_rerouting_flow(self):
        """ Test that access to the provided sales order is checked against the portal access token
        before rerouting the payment flow. """
        payment_portal_controller = PaymentPortal()

        with patch.object(CustomerPortal, '_document_check_access') as mock:
            payment_portal_controller._get_extra_payment_form_values()
            self.assertEqual(
                mock.call_count, 0, msg="No check should be made when sale_order_id is not provided."
            )

            mock.reset_mock()

            payment_portal_controller._get_extra_payment_form_values(
                sale_order_id=self.sale_order.id, access_token='whatever'
            )
            self.assertEqual(
                mock.call_count, 1, msg="The check should be made as sale_order_id is provided."
            )

    def test_check_payment_access_token_before_rerouting_flow(self):
        """ Test that access to the provided sales order is checked against the payment access token
        before rerouting the payment flow. """
        payment_portal_controller = PaymentPortal()

        def _document_check_access_mock(*_args, **_kwargs):
            raise AccessError('')

        with patch.object(
            CustomerPortal, '_document_check_access', _document_check_access_mock
        ), patch('odoo.addons.payment.utils.check_access_token') as check_payment_access_token_mock:
            try:
                payment_portal_controller._get_extra_payment_form_values(
                    sale_order_id=self.sale_order.id, access_token='whatever'
                )
            except Exception:
                pass  # We don't care if it runs or not; we only count the calls.
            self.assertEqual(
                check_payment_access_token_mock.call_count,
                1,
                msg="The access token should be checked again as a payment access token if the"
                    " check as a portal access token failed.",
            )

    @mute_logger('odoo.http')
    def test_transaction_route_rejects_unexpected_kwarg(self):
        url = self._build_url(f'/my/orders/{self.sale_order.id}/transaction')
        route_kwargs = {
            'access_token': self.sale_order._portal_ensure_token(),
            'partner_id': self.partner.id,  # This should be rejected.
        }
        with self.assertRaises(JsonRpcException, msg='odoo.exceptions.ValidationError'):
            self.make_jsonrpc_request(url, route_kwargs)

    def test_partial_payment_confirm_order(self):
        """
        Test that a sale order can be confirmed through partial payments and that
        correct mails are sent each time.
        """

        self.amount = self.sale_order.amount_total / 2

        with patch(
            'odoo.addons.sale.models.sale_order.SaleOrder._send_order_notification_mail',
        ) as notification_mail_mock:
            tx_pending = self._create_transaction(
                flow='direct',
                sale_order_ids=[self.sale_order.id],
                state='pending',
                reference='Test Transaction Draft 1',
            )

            self.assertEqual(self.sale_order.state, 'draft')

            tx_pending._set_done()
            tx_pending._post_process()

            self.assertEqual(notification_mail_mock.call_count, 1)
            notification_mail_mock.assert_called_once_with(
                self.env.ref('sale.mail_template_sale_payment_executed'))
            self.assertEqual(self.sale_order.state, 'draft')
            self.assertEqual(self.sale_order.amount_paid, self.amount)

            tx_done = self._create_transaction(
                flow='direct',
                sale_order_ids=[self.sale_order.id],
                state='done',
                reference='Test Transaction Draft 2',
            )
            tx_done._post_process()

            self.assertEqual(notification_mail_mock.call_count, 2)
            notification_mail_mock.assert_called_with(
                self.env.ref('sale.mail_template_sale_confirmation'))
            self.assertEqual(self.sale_order.state, 'sale')

    def test_automatic_invoice_mail_author(self):
        self.env['ir.config_parameter'].sudo().set_param('sale.automatic_invoice', 'True')

        portal_user = self.env['res.users'].create({
            'name': 'Portal Customer',
            'login': 'portal@test.com',
            'email': 'portal@test.com',
            'partner_id': self.partner_a.id,
            'groups_id': [(6, 0, [self.env.ref('base.group_portal').id])],
        })
        portal_user.partner_id.invoice_sending_method = 'email'

        sale_order = self.env['sale.order'].with_user(portal_user).sudo().create({
            'partner_id': portal_user.partner_id.id,
            'order_line': [(0, 0, {
                'product_id': self.product_a.id,
                'product_uom_qty': 1,
                'price_unit': 100.0,
            })],
        })

        self.amount = sale_order.amount_total
        tx = self._create_transaction(
            flow='redirect',
            sale_order_ids=[sale_order.id],
            state='done'
        )

        with mute_logger('odoo.addons.sale.models.payment_transaction'):
            tx.with_user(portal_user).sudo()._post_process()

        # Verify invoice was created and sent successfully
        invoice = sale_order.invoice_ids[0]
        self.assertTrue(invoice.is_move_sent, "Invoice should be marked as sent")
        invoice_sent_mail = invoice.message_ids[0]
        self.assertTrue(invoice_sent_mail.author_id.id not in invoice_sent_mail.notified_partner_ids.ids)
