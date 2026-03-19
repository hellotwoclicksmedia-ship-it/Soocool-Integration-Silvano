'use strict';
const config = require('../config');

/**
 * Parses Shopify order note_attributes into a SooCool-compatible time window.
 *
 * Expects note_attributes entries:
 *   { name: 'Delivery-Date', value: '2026/02/28' }
 *   { name: 'Delivery-Time', value: '8:00 AM - 6:00 PM' }
 *
 * @param {Array} noteAttributes
 * @returns {{ startTime: string, endTime: string }} ISO 8601 datetime strings
 */
function parseDeliveryWindow(noteAttributes) {
    const attrs = {};
    for (const attr of (noteAttributes || [])) {
        attrs[attr.name] = attr.value;
    }

    const dateStr = attrs['Delivery-Date']; // e.g. "2026/02/28"
    const timeStr = attrs['Delivery-Time']; // e.g. "8:00 AM - 6:00 PM"

    if (!dateStr || !timeStr) {
        throw new Error(`Missing Delivery-Date or Delivery-Time in note_attributes. Got: ${JSON.stringify(attrs)}`);
    }

    // Normalise date: "2026/02/28" → "2026-02-28"
    const datePart = dateStr.replace(/\//g, '-');

    // Parse time range: "8:00 AM - 6:00 PM"
    const timeParts = timeStr.split('-').map((t) => t.trim());
    if (timeParts.length !== 2) {
        throw new Error(`Cannot parse Delivery-Time: "${timeStr}"`);
    }

    const startTime = to24h(timeParts[0]);
    const endTime = to24h(timeParts[1]);

    return {
        startTime: `${datePart}T${startTime}:00+01:00`,
        endTime: `${datePart}T${endTime}:00+01:00`,
    };
}


function to24h(timeStr) {
    // e.g. "8:00 AM" → "08:00", "6:00 PM" → "18:00"
    const match = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!match) throw new Error(`Cannot parse time: "${timeStr}"`);
    let [, h, m, meridiem] = match;
    h = parseInt(h, 10);
    if (meridiem.toUpperCase() === 'PM' && h !== 12) h += 12;
    if (meridiem.toUpperCase() === 'AM' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${m}`;
}

/**
 * Splits a Dutch-style address string into streetName + houseNumber.
 * The suffix (apartment/floor) is joined to the house number with a hyphen,
 * matching the SooCool API example format (e.g. "20-C", "270-3E").
 * Examples:
 *   "Churchill-laan 270 3E" → { streetName: "Churchill-laan", houseNumber: "270-3E" }
 *   "Straat 12"             → { streetName: "Straat", houseNumber: "12" }
 *   "Straat 12A"            → { streetName: "Straat", houseNumber: "12A" }
 */
function splitAddress(address1) {
    const match = (address1 || '').trim().match(/^(.*?)\s+(\d+[A-Za-z]?)\s*(.*)$/);
    if (match) {
        const base = match[2].trim();
        const suffix = match[3].trim();
        return {
            streetName: match[1].trim(),
            houseNumber: suffix ? `${base}-${suffix}` : base,
        };
    }
    return { streetName: (address1 || '').trim(), houseNumber: '' };
}

/**
 * Maps Shopify shipping_address to SooCool address format.
 * SooCool requires houseNumber as a separate field from streetName.
 */
function mapAddress(shippingAddress) {
    const { streetName, houseNumber } = splitAddress(shippingAddress.address1);
    const person = [
        shippingAddress.first_name,
        shippingAddress.last_name,
    ].filter(Boolean).join(' ') || null;
    // If Shopify address2 has extra info (floor, apartment), append it to houseNumber
    const fullHouseNumber = shippingAddress.address2
        ? `${houseNumber}-${shippingAddress.address2}`
        : houseNumber;
    return {
        person,
        street: streetName,
        houseNumber: fullHouseNumber,
        city: shippingAddress.city,
        postCode: (shippingAddress.zip || '').replace(/\s+/g, ''),
        country: shippingAddress.country_code,
    };
}

/**
 * Sanitises a phone/mobile number for SooCool API.
 * Required format: ^[+]?[0-9]{10,15}$ — returns null if invalid/empty.
 */
function sanitisePhone(raw) {
    if (!raw) return null;
    const cleaned = raw.replace(/[\s()\-]/g, '');
    return /^[+]?[0-9]{10,15}$/.test(cleaned) ? cleaned : null;
}

/**
 * Strips non-ASCII / accented characters from a string so SooCool doesn't 500.
 * Replaces common European accented chars with ASCII equivalents, then strips the rest.
 */
function sanitiseContents(str) {
    const cleaned = (str || '')
        .replace(/[\u2018\u2019\u0060\u00B4]/g, "'")   // smart quotes → '
        .replace(/[\u201C\u201D]/g, '"')               // smart double quotes → "
        .replace(/[\u2013\u2014]/g, '-')               // em/en dash → -
        .replace(/\u2013|\u2014|\u2026/g, '-')         // ellipsis, dashes
        .normalize('NFD')                              // decompose accents
        .replace(/[\u0300-\u036f]/g, '')               // strip accent marks
        .replace(/[^\x00-\x7F]/g, '');                 // strip remaining non-ASCII

    return cleaned.substring(0, 100).trim();           // SooCool 500s if contents is too long
}

/**
 * Groups line items into physical boxes using product tags.
 *
 * Each product should have a tag like "bundle:Italian Forest bundle 12 box".
 * Items with the same bundle tag are grouped together.
 * If a group has doubled quantities (e.g. qty 4 instead of 2), it means
 * multiple physical boxes of the same type were ordered.
 *
 * @param {Array} lineItems - order.line_items from Shopify
 * @param {Map} tagsMap - productId → tags string (from shopify.getProductTags)
 * @param {number} itemsPerBox - how many total items fit in one box (default 12 for meals)
 * @returns {Array<{ bundleName: string, items: Array, boxCount: number }>}
 */
function groupItemsIntoBoxes(lineItems, tagsMap, itemsPerBox = 12) {
    // Group by bundle tag
    const groups = new Map();

    for (const item of lineItems) {
        const tags = tagsMap.get(item.product_id) || '';
        const bundleTag = tags.split(',').map(t => t.trim()).find(t => t.startsWith('bundle:'));
        const bundleName = bundleTag ? bundleTag.replace('bundle:', '').trim() : 'Unknown Bundle';

        if (!groups.has(bundleName)) {
            groups.set(bundleName, []);
        }
        groups.get(bundleName).push(item);
    }

    // Calculate box count per group
    const result = [];
    for (const [bundleName, items] of groups) {
        const totalQty = items.reduce((sum, i) => sum + i.quantity, 0);
        // For a 12-item box with 6 unique products, base qty per product is 2
        // If qty is 4, that means 2 boxes were ordered
        const uniqueProducts = items.length;
        const baseQtyPerProduct = itemsPerBox / uniqueProducts;
        const boxCount = Math.max(1, Math.round(items[0].quantity / baseQtyPerProduct));

        result.push({ bundleName, items, boxCount });
    }

    return result;
}

/**
 * Builds a SooCool order payload for the Pizza flow (delivery-only).
 * Creates one good (box) per quantity unit so qty 2 = 2 goods in SooCool.
 */
function buildPizzaPayload(order, deliveryWindow) {
    const address = mapAddress(order.shipping_address);

    // Build goods array: one good per physical box (quantity unit)
    const goods = [];
    const allGoodIds = [];
    let goodIdCounter = -1;

    for (const item of order.line_items) {
        for (let q = 0; q < item.quantity; q++) {
            goods.push({
                goodId: goodIdCounter,
                packagingType: 'box',
                contents: sanitiseContents(`Pizza #${order.order_number}: ${item.name}`),
                transportRequirements: ['cooled'],
            });
            allGoodIds.push(goodIdCounter);
            goodIdCounter--;
        }
    }

    return {
        orderReference: `SHOPIFY-${order.order_number}`,
        webhook: {
            webhookUrl: `${config.webhookBaseUrl}/webhooks/soocool/updates`,
            webhookUpdates: ['task_state'],
        },
        tasks: [
            {
                taskType: 'delivery',
                timeWindow: deliveryWindow,
                instructions: null,
                address,
                contactInfo: {
                    email: order.email || null,
                    phone: null,
                    mobile: sanitisePhone(order.shipping_address.phone),
                },
                goods: allGoodIds,
            },
        ],
        goods,
    };
}

/**
 * Builds a SooCool order payload for the Meal flow with multiple boxes.
 *
 * Delivery-only — SooCool picks up from their own NL warehouse.
 * The shipping label from SooCool is sent to the Italy warehouse,
 * who ships the box to SooCool's NL warehouse using that label.
 * SooCool then delivers to the customer (NL/BE address).
 *
 * @param {Object} order - Shopify order object
 * @param {Object} deliveryWindow - parsed delivery window
 * @param {Array} boxGroups - from groupItemsIntoBoxes()
 */
function buildMealPayload(order, deliveryWindow, boxGroups) {
    const customerAddress = mapAddress(order.shipping_address);

    // If no boxGroups provided, fall back to single-box behaviour
    if (!boxGroups || boxGroups.length === 0) {
        const contents = sanitiseContents(order.line_items.map((i) => `${i.name} x${i.quantity}`).join(', '));
        boxGroups = [{ bundleName: 'Meal Box', items: order.line_items, boxCount: 1 }];
    }

    // Build goods array: one good per physical box
    const goods = [];
    const allGoodIds = [];
    let goodIdCounter = -1;

    for (const group of boxGroups) {
        // Calculate total weight for one box (in grams)
        // Shopify stores weight in grams by default
        const totalGroupWeightGrams = group.items.reduce((sum, item) => {
            const itemWeight = item.grams || 0; // Shopify line_items have a 'grams' field
            return sum + (itemWeight * item.quantity);
        }, 0);
        const weightPerBoxGrams = Math.round(totalGroupWeightGrams / group.boxCount);

        for (let b = 0; b < group.boxCount; b++) {
            const good = {
                goodId: goodIdCounter,
                packagingType: 'box',
                contents: sanitiseContents(group.bundleName),
                transportRequirements: ['cooled'],
            };
            // SooCool requires weight as integer >= 1 (grams), omit if 0
            if (weightPerBoxGrams > 0) {
                good.weight = weightPerBoxGrams;
            }
            goods.push(good);
            allGoodIds.push(goodIdCounter);
            goodIdCounter--;
        }
    }

    return {
        orderReference: `SHOPIFY-${order.order_number}`,
        webhook: {
            webhookUrl: `${config.webhookBaseUrl}/webhooks/soocool/updates`,
            webhookUpdates: ['task_state'],
        },
        tasks: [
            {
                taskType: 'delivery',
                timeWindow: deliveryWindow,
                instructions: null,
                address: customerAddress,
                contactInfo: {
                    email: order.email || null,
                    phone: null,
                    mobile: sanitisePhone(order.shipping_address.phone),
                },
                goods: allGoodIds,
            },
        ],
        goods,
    };
}

module.exports = {
    parseDeliveryWindow,
    buildPizzaPayload,
    buildMealPayload,
    groupItemsIntoBoxes,
    mapAddress,
};
