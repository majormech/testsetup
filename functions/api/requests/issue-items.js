import { issueStationRequestItems } from '../../../src/server.js';

export async function onRequestPost(context) {
  return issueStationRequestItems(context.request, context.env);
}
