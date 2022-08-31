# -*- coding: utf-8 -*-
# Part of Odoo. See LICENSE file for full copyright and licensing details.

from odoo import fields, models

# <START_OF_CHANGE>
class BaseConfigSettings(models.TransientModel):
    _inherit = 'base.config.settings'

    microsoft_outlook_client_identifier = fields.Char('Outlook Client Id')
    microsoft_outlook_client_secret = fields.Char('Outlook Client Secret')

    def set_microsoft_outlook_client_data(self):
        self.env['ir.config_parameter'].set_param('microsoft_outlook_client_id',
                                                  (self.microsoft_outlook_client_identifier or '').strip(),
                                                  groups=['base.group_system'])
        self.env['ir.config_parameter'].set_param('microsoft_outlook_client_secret',
                                                  (self.microsoft_outlook_client_secret or '').strip(),
                                                  groups=['base.group_system'])

    def get_default_microsoft_outlook_client_data(self, fields):
        microsoft_outlook_client_id = self.env['ir.config_parameter'].\
            get_param('microsoft_outlook_client_id', default='')
        microsoft_outlook_client_secret = self.env['ir.config_parameter'].\
            get_param('microsoft_outlook_client_secret', default='')
        return dict(microsoft_outlook_client_identifier=microsoft_outlook_client_id,
                    microsoft_outlook_client_secret=microsoft_outlook_client_secret)
# <END_OF_CHANGE>
