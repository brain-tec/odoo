# -*- coding: utf-8 -*-
from odoo import tools, _
from odoo.tests import common
import base64
from odoo.modules.module import get_module_resource

class TestUBL(common.TransactionCase):
    def setUp(self):
        super(TestUBL, self).setUp()
        # Force user Belgium country.
        self.env.user.company_id.country = self.env.ref('base.be')
        self.partner_id = self.env['res.partner'].create({'name': 'TestUser', 'vat': 'BE0123456789'})
        self.account_id = self.env['account.account'].create({
            'name': 'Client',
            'code': '4000',
            'user_type_id': self.env.ref("account.data_account_type_receivable").id,
            'reconcile': True,
        })
        self.journal_id = self.env['account.journal'].create({
            'name': 'Vendor Bills',
            'type': 'purchase',
            'code': 'TVB',
            'default_credit_account_id': self.account_id.id,
            'default_debit_account_id': self.account_id.id,
        })

    def test_ubl_invoice_import(self):
        xml_file_path = get_module_resource('l10n_be_edi', 'test_xml_file', 'efff_test.xml')
        xml_file = open(xml_file_path, 'rb').read()
        invoice_id = self.env['account.invoice'].with_context(default_journal_id=self.journal_id.id, default_type='in_invoice').create({})

        attachment_id = self.env['ir.attachment'].create({
            'name': 'efff_test.xml',
            'datas_fname': 'efff_test.xml',
            'datas': base64.encodestring(xml_file),
            'res_id': invoice_id.id,
            'res_model': 'account.invoice',
        })

        invoice_id.message_post(attachment_ids=[attachment_id.id])

        self.assertEqual(invoice_id.amount_total, 666.50)
        self.assertEqual(invoice_id.amount_tax, 115.67)
        self.assertEqual(invoice_id.partner_id, self.partner_id)
