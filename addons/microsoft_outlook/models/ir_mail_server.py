# -*- coding: utf-8 -*-
# Part of Odoo. See LICENSE file for full copyright and licensing details.

import base64
import logging

from odoo import _, api, models
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)

class IrMailServer(models.Model):
    """Add the Outlook OAuth authentication on the outgoing mail servers."""

    _name = 'ir.mail_server'
    _inherit = ['ir.mail_server', 'microsoft.outlook.mixin']

    _OUTLOOK_SCOPE = 'https://outlook.office.com/SMTP.Send'

    @api.constrains('use_microsoft_outlook_service', 'smtp_pass', 'smtp_encryption')
    def _check_use_microsoft_outlook_service(self):
        for server in self:
            if not server.use_microsoft_outlook_service:
                continue

            if server.smtp_pass:
                raise UserError(_(
                    'Please leave the password field empty for Outlook mail server %r. '
                    'The OAuth process does not require it')
                    % server.name)

            if server.smtp_encryption != 'starttls':
                raise UserError(_(
                    'Incorrect Connection Security for Outlook mail server %r. '
                    'Please set it to "TLS (STARTTLS)".')
                    % server.name)

    @api.onchange('smtp_encryption')
    def _onchange_encryption(self):
        """Do not change the SMTP configuration if it's a Outlook server

        (e.g. the port which is already set)"""
        if not self.use_microsoft_outlook_service:
            super()._onchange_encryption()

    @api.onchange('use_microsoft_outlook_service')
    def _onchange_use_microsoft_outlook_service(self):
        if self.use_microsoft_outlook_service:
            self.smtp_host = 'smtp.outlook.com'
            self.smtp_encryption = 'starttls'
            self.smtp_port = 587
        else:
            self.microsoft_outlook_refresh_token = False
            self.microsoft_outlook_access_token = False
            self.microsoft_outlook_access_token_expiration = False

    # <START_OF_CHANGE>
    def connect(self, host=None, port=None, user=None, password=None, encryption=None,
                smtp_debug=False, mail_server_id=None):

        msg = "IrMailServer1::connect() user %s, encryption %s, mail_server_id %s, " \
              "self.use_microsoft_outlook_service %s" % (
            user, encryption, mail_server_id, self.use_microsoft_outlook_service)
        _logger.info(msg)
        if len(self) == 1 and self.use_microsoft_outlook_service:
            # Call super without user to setup connection but don't login.
            mail_server_user = user
            if mail_server_id:
                _logger.info('if mail_server_id')
                mail_server = self.sudo().browse(mail_server_id)
                mail_server_user = mail_server.smtp_user
                mail_server.smtp_user = None
                connection = super(IrMailServer, self).connect(host, port, user=None, password=password,
                                                               encryption=encryption, smtp_debug=smtp_debug,
                                                               mail_server_id=mail_server_id)
                mail_server.smtp_user = mail_server_user
            else:
                _logger.info('else mail_server_id')
                connection = super(IrMailServer, self).connect(host, port, user=None, password=password,
                                                               encryption=encryption, smtp_debug=smtp_debug,
                                                               mail_server_id=mail_server_id)
            auth_string = self._generate_outlook_oauth2_string(mail_server_user)
            oauth_param = base64.b64encode(auth_string.encode()).decode()
            connection.ehlo()
            connection.docmd('AUTH', 'XOAUTH2 %s' % oauth_param)
        else:
            _logger.info('else use_microsoft_outlook_service')
            connection = super(IrMailServer, self).connect(host, port, user=user, password=password,
                                                           encryption=encryption, smtp_debug=smtp_debug,
                                                           mail_server_id=mail_server_id)
        return connection
    # <END_OF_CHANGE>
