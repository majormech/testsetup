import { getAdminSettings, updateAdminSettings } from '../../../src/server.js';

export async function onRequestGet(context) {
  return getAdminSettings(context.request, context.env);
}

export async function onRequestPost(context) {
  return updateAdminSettings(context.request, context.env);
}
