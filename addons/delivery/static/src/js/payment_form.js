import PaymentForm from '@payment/js/payment_form';

PaymentForm.include({

    /**
     * Configure 'cash_on_delivery' as a pay-later method.
     *
     * @override
     */
    _isPayLaterMethod(paymentMethodCode) {
        return paymentMethodCode === 'cash_on_delivery' || this._super(...arguments);
    }

});
