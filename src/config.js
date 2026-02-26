'use strict';
require('dotenv').config();

function require_env(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

module.exports = {
  port: process.env.PORT || 3000,

  soocool: {
    apiKey: require_env('SOOCOOL_API_KEY'),
    baseUrl: process.env.SOOCOOL_BASE_URL || 'https://api.staging.soocool.nl',
  },

  shopify: {
    storeUrl: require_env('SHOPIFY_STORE_URL'),
    accessToken: require_env('SHOPIFY_ACCESS_TOKEN'),
    webhookSecret: require_env('SHOPIFY_WEBHOOK_SECRET').trim(),
  },

  webhookBaseUrl: require_env('WEBHOOK_BASE_URL'),

  productTypes: {
    pizza: process.env.PIZZA_PRODUCT_TYPE || 'Pizza',
    meal: process.env.MEAL_PRODUCT_TYPE || 'Meal',
  },
};
