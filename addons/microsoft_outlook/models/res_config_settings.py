# -*- coding: utf-8 -*-
# Part of Odoo. See LICENSE file for full copyright and licensing details.

from odoo import fields, models


class ResConfigSettings(models.TransientModel):
    _inherit = 'res.config.settings'

    # <START_OF_CHANGE>
    microsoft_outlook_client_identifier = fields.Char('Outlook Client Id',
                                                      related="company_id.microsoft_outlook_client_identifier")
    microsoft_outlook_client_secret = fields.Char('Outlook Client Secret',
                                                  related="company_id.microsoft_outlook_client_secret")
    # <END_OF_CHANGE>
