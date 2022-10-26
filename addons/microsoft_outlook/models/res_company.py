# -*- coding: utf-8 -*-
# Part of Odoo. See LICENSE file for full copyright and licensing details.
# <START_OF_CHANGE>
from odoo import fields, models


class ResCompany(models.Model):
    _inherit = 'res.company'

    microsoft_outlook_client_identifier = fields.Char('Outlook Client Id')
    microsoft_outlook_client_secret = fields.Char('Outlook Client Secret')
# <END_OF_CHANGE>
