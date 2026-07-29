import { CORS_HEADERS } from '../config/constants.js';

export function jsonResponse(data, status = 200, customHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      ...customHeaders,
    },
  });
}

export function errorResponse(message, status = 500) {
  return jsonResponse({ success: false, error: message }, status);
}
