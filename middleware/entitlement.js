// Attaches req.entitlement (lib/entitlement.js) for the signed-in user.
// Mount AFTER authMiddleware. The object is what every plan/usage/credit
// decision in the controllers reads - never the request body.
const { loadEntitlement } = require('../lib/entitlement');
const { serverCopy } = require('../lib/copy');

async function entitlementMiddleware(req, res, next) {
  try {
    const ent = await loadEntitlement(req.user.userId);
    if (!ent) return res.status(401).json({ error: { message: '- sign in to continue.' } });
    req.entitlement = ent;
    return next();
  } catch (err) {
    console.error('[entitlement]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

module.exports = entitlementMiddleware;
