'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

process.env.SOOCOOL_API_KEY = 'test';
process.env.SHOPIFY_STORE_URL = 'test.myshopify.com';
process.env.SHOPIFY_ACCESS_TOKEN = 'test';
process.env.SHOPIFY_WEBHOOK_SECRET = 'test';
process.env.WEBHOOK_BASE_URL = 'https://test.example.com';

const { parseDeliveryWindow, buildPizzaPayload, buildMealPayload, parseTimeFromShippingTitle } = require('../src/utils/orderMapper');

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
            assert.equal(win.startTime, '2026-02-28T08:00:00+01:00');
            assert.equal(win.endTime, '2026-02-28T18:00:00+01:00');
        });

        it('throws if Delivery-Date is missing', () => {
            assert.throws(() => parseDeliveryWindow([{ name: 'Delivery-Time', value: '8:00 AM - 6:00 PM' }]));
        });

        it('throws if Delivery-Time is missing and no shipping line fallback', () => {
            assert.throws(() => parseDeliveryWindow([{ name: 'Delivery-Date', value: '2026/02/28' }]));
        });

        it('falls back to shipping line when Delivery-Time is missing', () => {
            const noteAttrs = [{ name: 'Delivery-Date', value: '2026/02/28' }];
            const shippingLines = [{ title: 'Afternoon Delivery 1PM to 6PM' }];
            const win = parseDeliveryWindow(noteAttrs, shippingLines);
            assert.equal(win.startTime, '2026-02-28T13:00:00+01:00');
            assert.equal(win.endTime, '2026-02-28T18:00:00+01:00');
        });

        it('prefers Delivery-Time over shipping line when both are present', () => {
            const shippingLines = [{ title: 'Afternoon Delivery 1PM to 6PM' }];
            const win = parseDeliveryWindow(sampleNoteAttributes, shippingLines);
            // Should use 8:00 AM - 6:00 PM from note_attributes, not 1PM-6PM from shipping line
            assert.equal(win.startTime, '2026-02-28T08:00:00+01:00');
            assert.equal(win.endTime, '2026-02-28T18:00:00+01:00');
        });
    });

    describe('parseTimeFromShippingTitle', () => {
        it('parses "1PM to 6PM" format', () => {
            const result = parseTimeFromShippingTitle('Afternoon Delivery 1PM to 6PM');
            assert.deepEqual(result, { startTime24h: '13:00', endTime24h: '18:00' });
        });

        it('parses "8AM - 12PM" format', () => {
            const result = parseTimeFromShippingTitle('Morning Delivery 8AM - 12PM');
            assert.deepEqual(result, { startTime24h: '08:00', endTime24h: '12:00' });
        });

        it('parses "6:00 PM - 9:00 PM" format', () => {
            const result = parseTimeFromShippingTitle('Evening Delivery 6:00 PM - 9:00 PM');
            assert.deepEqual(result, { startTime24h: '18:00', endTime24h: '21:00' });
        });

        it('parses "8:00AM to 6:00PM" (no spaces) format', () => {
            const result = parseTimeFromShippingTitle('Next Day 8:00AM to 6:00PM');
            assert.deepEqual(result, { startTime24h: '08:00', endTime24h: '18:00' });
        });

        it('parses "1 PM to 6 PM" (space between hour and meridiem)', () => {
            const result = parseTimeFromShippingTitle('Same Day 1 PM to 6 PM');
            assert.deepEqual(result, { startTime24h: '13:00', endTime24h: '18:00' });
        });

        it('parses 24-hour "08:00-18:00" format', () => {
            const result = parseTimeFromShippingTitle('Delivery 08:00-18:00');
            assert.deepEqual(result, { startTime24h: '08:00', endTime24h: '18:00' });
        });

        it('parses 24-hour "8:00 to 18:00" format', () => {
            const result = parseTimeFromShippingTitle('Delivery 8:00 to 18:00');
            assert.deepEqual(result, { startTime24h: '08:00', endTime24h: '18:00' });
        });

        it('handles 12AM correctly (midnight)', () => {
            const result = parseTimeFromShippingTitle('Late Night 10PM to 12AM');
            assert.deepEqual(result, { startTime24h: '22:00', endTime24h: '00:00' });
        });

        it('handles 12PM correctly (noon)', () => {
            const result = parseTimeFromShippingTitle('Midday 12PM to 6PM');
            assert.deepEqual(result, { startTime24h: '12:00', endTime24h: '18:00' });
        });

        it('returns null for titles with no time info', () => {
            assert.equal(parseTimeFromShippingTitle('Standard Shipping'), null);
            assert.equal(parseTimeFromShippingTitle('Free Delivery'), null);
            assert.equal(parseTimeFromShippingTitle(''), null);
            assert.equal(parseTimeFromShippingTitle(null), null);
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
        it('produces a delivery-only payload', () => {
            const win = parseDeliveryWindow(sampleNoteAttributes);
            const payload = buildMealPayload(sampleOrder, win);
            assert.equal(payload.tasks.length, 1);
            assert.equal(payload.tasks[0].taskType, 'delivery');
        });
    });
});
