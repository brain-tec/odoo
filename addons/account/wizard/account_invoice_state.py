# -*- coding: utf-8 -*-
from openerp import models, api, _
from openerp.exceptions import UserError
import logging
import openerp

_logger = logging.getLogger(__name__)


class AccountInvoiceConfirm(models.TransientModel):
    """
    This wizard will confirm the all the selected draft invoices
    """

    _name = "account.invoice.confirm"
    _description = "Confirm the selected invoices"

    def cron_signal_workflow(self, cr, uid):
        """This cron is needed to confirm the invoices with auto_confirm = True"""
        invoice_ids = self.pool['account.invoice'].search(cr, uid, [('auto_confirm', '=', True)], limit=10)
        invoices = self.pool['account.invoice'].browse(cr, uid, invoice_ids)
        for invoice in invoices:
            try:
                invoice.signal_workflow('invoice_open')
            except Exception, e:
                pass
            finally:
                invoice.auto_confirm = False

    @api.multi
    def invoice_confirm(self):
        """ Sometimes, more than 500 invoices must be confirmed at once.
        Since QR-Bill where added to this project, some error appears in the GUI because of some timeout.
        We cannot find the reason, but at least we have a solution: a cron are now implemented.
        The invoices which can be confirmed, will be confirmed during cron execution.
        """
        context = dict(self._context or {})
        # Getting not confirmable invoices does not need long time, and we can spare some time
        all_invoices = self.env['account.invoice'].browse(context.get('active_ids', []) or [])
        not_confirmable_invoices = all_invoices.filtered(lambda x: x.state not in ('draft', 'proforma', 'proforma2'))
        to_confirm_invoice_ids = list(set(all_invoices.ids) - set(not_confirmable_invoices.ids))
        invoices = self.env['account.invoice'].browse(to_confirm_invoice_ids)

        # We use a new cursor to ensure that auto_confirm is set, also if UserError raised
        with api.Environment.manage():
            with openerp.registry(self.env.cr.dbname).cursor() as new_cr:
                new_env = api.Environment(new_cr, self._uid, self._context)
                for invoice in invoices:
                    invoice.with_env(new_env).write({'auto_confirm': True})

        if not_confirmable_invoices:
            raise UserError(_("Some of the selected invoice(s) will not be confirmed as they are not in"
                              " 'Draft' or 'Pro-Forma' state: %s \n" % not_confirmable_invoices.ids))
        return {'type': 'ir.actions.act_window_close'}


class AccountInvoiceCancel(models.TransientModel):
    """
    This wizard will cancel the all the selected invoices.
    If in the journal, the option allow cancelling entry is not selected then it will give warning message.
    """

    _name = "account.invoice.cancel"
    _description = "Cancel the Selected Invoices"

    @api.multi
    def invoice_cancel(self):
        context = dict(self._context or {})
        active_ids = context.get('active_ids', []) or []

        for record in self.env['account.invoice'].browse(active_ids):
            if record.state in ('cancel', 'paid'):
                raise UserError(_("Selected invoice(s) cannot be cancelled as they are already in 'Cancelled' or 'Done' state."))
            record.signal_workflow('invoice_cancel')
        return {'type': 'ir.actions.act_window_close'}
