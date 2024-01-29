# Part of Odoo. See LICENSE file for full copyright and licensing details.
from odoo import api, SUPERUSER_ID
from odoo.addons.account.models.chart_template import update_taxes_from_templates


def migrate(cr, version):
    print('stso migration')
    new_template_to_tax = update_taxes_from_templates(cr, 'l10n_ch.l10nch_chart_template')
    print('::migrate()', locals())
    if new_template_to_tax:
        _, new_tax_ids = zip(*new_template_to_tax)
        env = api.Environment(cr, SUPERUSER_ID, {})
        ids = [obj.id for obj in new_tax_ids]
        print('::migrate()', locals())
        env['account.tax'].browse(ids).active = True
