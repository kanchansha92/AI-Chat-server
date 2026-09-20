// Validates required/security-sensitive env vars at boot. Called once from
// server.js before the app starts listening - fail fast and loud beats
// silently running with an insecure default in production.
function assertEnvIsSafe() {
  const isProd = process.env.NODE_ENV === 'production';
  const problems = [];

  if (!process.env.DATABASE_URL) {
    problems.push('DATABASE_URL is not set.');
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (isProd) {
    if (!jwtSecret || jwtSecret === 'privateaile_jwt_secret_change_in_production') {
      problems.push(
        'JWT_SECRET is missing or still the placeholder default. Set a long, random value in production.'
      );
    } else if (jwtSecret.length < 32) {
      problems.push('JWT_SECRET is shorter than 32 characters - use a longer random value.');
    }

    if (!process.env.CORS_ORIGIN) {
      problems.push('CORS_ORIGIN is not set in production.');
    }

    // Without PUBLIC_URL, middleware/upload.js builds public file URLs from the
    // request's Host header - which the client controls - and PERSISTS them into
    // User.avatar, Character.avatar and ChatMessage.attachments[].url. One
    // request with a forged Host writes an attacker-chosen origin into rows that
    // are later rendered in the app and in the admin dashboard.
    if (!process.env.PUBLIC_URL) {
      problems.push(
        'PUBLIC_URL is not set in production. Uploaded-file URLs would be built from the ' +
        'client-supplied Host header and stored in the database.'
      );
    }

    // Billing. Razorpay is the payment provider (lib/billing/razorpay.js).
    // Without the keys every billing endpoint answers 503 - acceptable in
    // development, never in production.
    for (const k of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET']) {
      if (!process.env[k]) problems.push(`${k} is not set in production.`);
    }
    for (const plan of ['BASIC', 'PLUS', 'ULTRA']) {
      for (const cycle of ['MONTHLY', 'ANNUAL']) {
        const k = `RZP_PLAN_${plan}_${cycle}`;
        if (!process.env[k]) problems.push(`${k} (Razorpay plan id) is not set in production.`);
      }
    }
    if (!process.env.SIGNED_URL_SECRET && !process.env.JWT_SECRET) {
      problems.push('SIGNED_URL_SECRET is not set.');
    }
  }

  if (problems.length > 0) {
    console.error(
      'Refusing to start - insecure configuration:\n' + problems.map((p) => `  - ${p}`).join('\n')
    );
    process.exit(1);
  }
}

module.exports = { assertEnvIsSafe };
