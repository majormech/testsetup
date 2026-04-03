import { getAdminErrors } from '../../../src/server.js';

export async function onRequestGet(context) {
  return getAdminErrors(context.request, context.env);
}
