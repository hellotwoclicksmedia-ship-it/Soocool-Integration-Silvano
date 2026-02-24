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
 * Builds a SooCool order payload for the Pizza flow (delivery-only).
 */
function buildPizzaPayload(order, deliveryWindow) {
    const address = mapAddress(order.shipping_address);
    const contents = order.line_items.map((i) => `${i.name} x${i.quantity}`).join(', ');

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
                goods: [-1],
            },
        ],
        goods: [
            {
                goodId: -1,
                packagingType: 'box',
                contents: sanitiseContents(`Pizza - Order #${order.order_number}: ${contents}`),
                transportRequirements: ['cooled'],
            },
        ],
    };
}

/**
 * Builds a SooCool order payload for the Meal flow.
 *
 * Delivery-only — SooCool picks up from their own NL warehouse.
 * The shipping label from SooCool is sent to the Italy warehouse,
 * who ships the box to SooCool's NL warehouse using that label.
 * SooCool then delivers to the customer (NL/BE address).
 */
function buildMealPayload(order, deliveryWindow) {
    const customerAddress = mapAddress(order.shipping_address);
    const contents = sanitiseContents(order.line_items.map((i) => `${i.name} x${i.quantity}`).join(', '));

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
                goods: [-1],
            },
        ],
        goods: [
            {
                goodId: -1,
                packagingType: 'box',
                contents: sanitiseContents(`Meal Box - Order #${order.order_number}: ${contents}`),
                transportRequirements: ['cooled'],
            },
        ],
    };
}

module.exports = {
    parseDeliveryWindow,
    buildPizzaPayload,
    buildMealPayload,
    mapAddress,
};
