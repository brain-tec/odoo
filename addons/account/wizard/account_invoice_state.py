# -*- coding: utf-8 -*-
from openerp import models, api, _
from openerp.exceptions import UserError
import threading

import openerp
import logging
_logger = logging.getLogger(__name__)


class AccountInvoiceConfirm(models.TransientModel):
    """
    This wizard will confirm the all the selected draft invoices
    """

    _name = "account.invoice.confirm"
    _description = "Confirm the selected invoices"

    def signal_workflow_with_cr(self):
        """ This function is needed to confirm invoices and don't break the progress
        """
        context = dict(self._context or {})
        active_ids = context.get('active_ids', []) or []
        proc_obj = self.env['account.invoice'].browse(active_ids)
        # As this function is in a new thread, I need to open new cursors, because the old one may be closed
        for record in proc_obj:
            with api.Environment.manage():
                with openerp.registry(self.env.cr.dbname).cursor() as new_cr:
                    new_env = api.Environment(new_cr, self._uid, self._context)
                    try:
                        if record.state not in ('draft', 'proforma', 'proforma2'):
                            _logger.debug("Selected invoice(s) cannot be confirmed as "
                                          "they are not in 'Draft' or 'Pro-Forma' state. %s", record.id)
                            continue
                        record.with_env(new_env).signal_workflow('invoice_open')

                        new_env.cr.commit()
                    except Exception, e:
                        new_env.cr.rollback()
                        _logger.debug("Selected invoice cannot be confirmed: %s", record.id)
        return {}


    @api.multi
    def invoice_confirm(self):
        """ Sometimes, more than 500 invoices are confirmed at once.
        Since QR-Bill where added to this project, some error appears in the GUI because of some timeout.
        We cannot find the reason, but at least we have a solution: an independent thread and cursors are
        now implemented. The invoices which are possible to be confirmed, will be confirmed
        on the background
        """
        context = dict(self._context or {})
        active_ids = context.get('active_ids', []) or []
        records = self.env['account.invoice'].browse(active_ids)
        if len(records) < 5:
            for record in self.env['account.invoice'].browse(active_ids):
                if record.state not in ('draft', 'proforma', 'proforma2'):
                    raise UserError(_("Selected invoice(s) cannot be confirmed as "
                                      "they are not in 'Draft' or 'Pro-Forma' state."))
                record.signal_workflow('invoice_open')
        else:
            for i in range(0, len(active_ids), 50):
                context['active_ids'] = active_ids[i:i + 50]
                threading.Thread(target=self.with_context(context).signal_workflow_with_cr).start()
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
