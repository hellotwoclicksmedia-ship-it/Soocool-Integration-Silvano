'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

process.env.SOOCOOL_API_KEY = 'test';
process.env.SHOPIFY_STORE_URL = 'test.myshopify.com';
process.env.SHOPIFY_ACCESS_TOKEN = 'test';
process.env.SHOPIFY_WEBHOOK_SECRET = 'test';
process.env.WEBHOOK_BASE_URL = 'https://test.example.com';

const { parseDeliveryWindow, buildPizzaPayload, buildMealPayload } = require('../src/utils/orderMapper');

const sampleNoteAttributes = [
    { name: 'Delivery-Date', value: '2026/02/28' },
    { name: 'Delivery-Time', value: '8:00 AM - 6:00 PM' },
    { name: 'Delivery-Location-Id', value: '286946' },
    { name: 'Delivery-Slot-Id', value: '128762835' },
    { name: 'Checkout-Method', value: 'delivery' },
];

const sampleOrder = {
    id: '987654321',
    order_number: '1001',
    email: 'customer@example.com',
    note_attributes: sampleNoteAttributes,
    shipping_address: {
        first_name: 'Jan',
        last_name: 'de Vries',
        address1: 'Keizersgracht 1',
        address2: '',
        city: 'Amsterdam',
        zip: '1015 CJ',
        country_code: 'NL',
        phone: '+31612345678',
    },
    line_items: [
        { title: 'Margherita', name: 'Margherita', product_type: 'Pizza', quantity: 2, sku: 'PIZ-001', price: '12.50' },
    ],
};

describe('orderMapper', () => {
    describe('parseDeliveryWindow', () => {
        it('parses date and time correctly', () => {
            const win = parseDeliveryWindow(sampleNoteAttributes);
            assert.equal(win.startTime, '2026-02-28T08:00:00');
            assert.equal(win.endTime, '2026-02-28T18:00:00');
        });

        it('throws if Delivery-Date is missing', () => {
            assert.throws(() => parseDeliveryWindow([{ name: 'Delivery-Time', value: '8:00 AM - 6:00 PM' }]));
        });

        it('throws if Delivery-Time is missing', () => {
            assert.throws(() => parseDeliveryWindow([{ name: 'Delivery-Date', value: '2026/02/28' }]));
        });
    });

    describe('buildPizzaPayload', () => {
        it('produces a delivery-only payload', () => {
            const win = parseDeliveryWindow(sampleNoteAttributes);
            const payload = buildPizzaPayload(sampleOrder, win);
            assert.equal(payload.tasks.length, 1);
            assert.equal(payload.tasks[0].taskType, 'delivery');
            assert.equal(payload.orderReference, 'SHOPIFY-1001');
            assert.deepEqual(payload.goods[0].transportRequirements, ['cooled']);
        });

        it('maps shipping address correctly', () => {
            const win = parseDeliveryWindow(sampleNoteAttributes);
            const payload = buildPizzaPayload(sampleOrder, win);
            assert.equal(payload.tasks[0].address.city, 'Amsterdam');
            assert.equal(payload.tasks[0].address.country, 'NL');
        });
    });

    describe('buildMealPayload', () => {
        it('produces a pickup + delivery payload', () => {
            const win = parseDeliveryWindow(sampleNoteAttributes);
            const payload = buildMealPayload(sampleOrder, win);
            assert.equal(payload.tasks.length, 2);
            assert.equal(payload.tasks[0].taskType, 'pickup');
            assert.equal(payload.tasks[1].taskType, 'delivery');
        });

        it('pickup is the day before delivery', () => {
            const win = parseDeliveryWindow(sampleNoteAttributes);
            const payload = buildMealPayload(sampleOrder, win);
            const pickupDate = payload.tasks[0].timeWindow.startTime.slice(0, 10);
            assert.equal(pickupDate, '2026-02-27');
        });
    });
});
