import { resetAdminUserPin } from '../../../../src/server.js';

export async function onRequestPost(context) {
  return resetAdminUserPin(context.request, context.env);
}
