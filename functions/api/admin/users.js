import { createAdminUser, getAdminUsers, updateAdminUser } from '../../../src/server.js';

export async function onRequestGet(context) {
  return getAdminUsers(context.request, context.env);
}

export async function onRequestPost(context) {
  return createAdminUser(context.request, context.env);
}

export async function onRequestPut(context) {
  return updateAdminUser(context.request, context.env);
}
