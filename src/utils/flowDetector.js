'use strict';
const config = require('../config');

/**
 * Detects the flow type from Shopify order line items.
 * Uses the product_type field — available in webhook payload without extra API calls.
 *
 * @param {Array} lineItems - order.line_items from Shopify webhook
 * @returns {'pizza' | 'meal' | 'unknown'}
 */
function detectFlow(lineItems) {
    if (!Array.isArray(lineItems) || lineItems.length === 0) {
        console.warn('[flowDetector] No line items found');
        return 'unknown';
    }

    const pizzaType = config.productTypes.pizza.toLowerCase();
    const mealType = config.productTypes.meal.toLowerCase();

    const types = new Set(
        lineItems.map((item) => (item.product_type || '').toLowerCase().trim())
    );

    const hasPizza = types.has(pizzaType);
    const hasMeal = types.has(mealType);

    if (hasPizza && hasMeal) {
        console.warn('[flowDetector] Mixed product types in order — skipping');
        return 'unknown';
    }
    if (hasPizza) return 'pizza';
    if (hasMeal) return 'meal';

    console.warn('[flowDetector] No recognised product_type found. Types:', [...types]);
    return 'unknown';
}

module.exports = { detectFlow };
