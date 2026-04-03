import { deleteAdminStation } from '../../../../src/server.js';

export async function onRequestPost(context) {
  return deleteAdminStation(context.request, context.env);
}
