'use strict';
require('dotenv').config();

function require_env(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val.trim();
}

module.exports = {
  port: process.env.PORT || 3000,

  soocool: {
    apiKey: require_env('SOOCOOL_API_KEY'),
    baseUrl: (process.env.SOOCOOL_BASE_URL || 'https://api.soocool.nl').trim(),
  },

  shopify: {
    storeUrl: require_env('SHOPIFY_STORE_URL'),
    accessToken: require_env('SHOPIFY_ACCESS_TOKEN').replace(/^=+/, ''),
    webhookSecret: require_env('SHOPIFY_WEBHOOK_SECRET').replace(/[^0-9a-fA-F]/g, ''),
  },

  webhookBaseUrl: require_env('WEBHOOK_BASE_URL'),

  productTypes: {
    pizza: process.env.PIZZA_PRODUCT_TYPE || 'Pizza',
    meal: process.env.MEAL_PRODUCT_TYPE || 'Meal',
  },
};
