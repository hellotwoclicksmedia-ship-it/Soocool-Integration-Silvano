'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Stub config before requiring flowDetector
process.env.SOOCOOL_API_KEY = 'test';
process.env.SHOPIFY_STORE_URL = 'test.myshopify.com';
process.env.SHOPIFY_ACCESS_TOKEN = 'test';
process.env.SHOPIFY_WEBHOOK_SECRET = 'test';
process.env.WEBHOOK_BASE_URL = 'https://test.example.com';

const { detectFlow } = require('../src/utils/flowDetector');

describe('flowDetector', () => {
    it('detects pizza from product_type', () => {
        const items = [{ product_type: 'Pizza', title: 'Margherita' }];
        assert.equal(detectFlow(items), 'pizza');
    });

    it('detects meal from product_type', () => {
        const items = [{ product_type: 'Meal', title: 'Meal Box' }];
        assert.equal(detectFlow(items), 'meal');
    });

    it('is case-insensitive', () => {
        assert.equal(detectFlow([{ product_type: 'PIZZA' }]), 'pizza');
        assert.equal(detectFlow([{ product_type: 'meal' }]), 'meal');
    });

    it('returns unknown for unrecognised type', () => {
        const items = [{ product_type: 'Beverage' }];
        assert.equal(detectFlow(items), 'unknown');
    });

    it('returns unknown for mixed types', () => {
        const items = [
            { product_type: 'Pizza' },
            { product_type: 'Meal' },
        ];
        assert.equal(detectFlow(items), 'unknown');
    });

    it('returns unknown for empty array', () => {
        assert.equal(detectFlow([]), 'unknown');
    });
});
