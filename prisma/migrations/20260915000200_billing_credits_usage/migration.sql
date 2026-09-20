-- Billing, credits and usage (Phase 2). Additive only: new enums, new tables,
-- three nullable-or-defaulted columns on User. Every existing user gets a
-- credit wallet at the end (idempotent insert).
-- Comments here must not contain semicolons.

-- CreateEnum
CREATE TYPE "PlanSource" AS ENUM ('FREE', 'TRIAL', 'PAID', 'GRANT');

-- CreateEnum
CREATE TYPE "BillingCycle" AS ENUM ('MONTHLY', 'ANNUAL');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('INCOMPLETE', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED', 'PAUSED');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('RAZORPAY');

-- CreateEnum
CREATE TYPE "MandateStatus" AS ENUM ('NONE', 'PENDING', 'ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "PaymentMethodType" AS ENUM ('NONE', 'CARD', 'UPI', 'NETBANKING', 'WALLET', 'OTHER');

-- CreateEnum
CREATE TYPE "PaymentKind" AS ENUM ('SUBSCRIPTION', 'RENEWAL', 'CREDIT_PACK', 'TRIAL_AUTH');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('CREATED', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED');

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('PENDING', 'PROCESSED', 'FAILED', 'IGNORED');

-- CreateEnum
CREATE TYPE "PlanChangeReason" AS ENUM ('TRIAL_START', 'TRIAL_CONVERT', 'TRIAL_CANCEL', 'UPGRADE', 'DOWNGRADE', 'RENEWAL', 'EXPIRE', 'PAYMENT_FAILED', 'ADMIN', 'RESUME');

-- CreateEnum
CREATE TYPE "CreditGrantSource" AS ENUM ('PLAN_MONTHLY', 'ADMIN', 'PROMO', 'TRIAL');

-- CreateEnum
CREATE TYPE "CreditTxType" AS ENUM ('GRANT', 'PURCHASE', 'SPEND', 'REFUND', 'EXPIRE', 'ADJUST');

-- CreateEnum
CREATE TYPE "CreditFeature" AS ENUM ('PREMIUM_REPLY', 'IMAGE', 'HD_IMAGE', 'REFERENCE_EDIT', 'PREMIUM_VOICE', 'MODEL_CALL', 'PACK', 'PLAN', 'ADMIN', 'EXPIRY');

-- CreateEnum
CREATE TYPE "UsageMetric" AS ENUM ('MESSAGES', 'PREMIUM_REPLIES', 'IMAGES', 'HD_IMAGES', 'VOICE_SECONDS', 'SPOKEN_REPLIES', 'NEW_CHARACTERS', 'PERSONA_CHANGES', 'GROUPS_CREATED', 'DOCUMENT_UPLOADS', 'ASK_MESSAGES');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "planSource" "PlanSource" NOT NULL DEFAULT 'FREE',
ADD COLUMN     "razorpayCustomerId" TEXT,
ADD COLUMN     "trialUsedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "plan" "Plan" NOT NULL,
    "cycle" "BillingCycle" NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "provider" "PaymentProvider" NOT NULL DEFAULT 'RAZORPAY',
    "providerSubscriptionId" TEXT,
    "pendingProviderSubscriptionId" TEXT,
    "providerPlanId" TEXT,
    "providerCustomerId" TEXT,
    "mandateStatus" "MandateStatus" NOT NULL DEFAULT 'NONE',
    "paymentMethodType" "PaymentMethodType" NOT NULL DEFAULT 'NONE',
    "paymentMethodLast4" TEXT,
    "trialStartsAt" TIMESTAMP(3),
    "trialEndsAt" TIMESTAMP(3),
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "cancelledAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "graceUntil" TIMESTAMP(3),
    "trialReminder12SentAt" TIMESTAMP(3),
    "trialReminder14SentAt" TIMESTAMP(3),
    "renewalFailedCount" INTEGER NOT NULL DEFAULT 0,
    "pendingPlan" "Plan",
    "pendingCycle" "BillingCycle",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "subscriptionId" TEXT,
    "kind" "PaymentKind" NOT NULL,
    "provider" "PaymentProvider" NOT NULL DEFAULT 'RAZORPAY',
    "providerOrderId" TEXT,
    "providerPaymentId" TEXT,
    "providerInvoiceId" TEXT,
    "providerRefundId" TEXT,
    "amountPaise" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "failureCode" TEXT,
    "failureReason" TEXT,
    "packId" TEXT,
    "creditsGranted" DECIMAL(10,2),
    "refundedPaise" INTEGER NOT NULL DEFAULT 0,
    "plan" "Plan",
    "cycle" "BillingCycle",
    "idempotencyKey" TEXT,
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL DEFAULT 'RAZORPAY',
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanChange" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fromPlan" "Plan" NOT NULL,
    "toPlan" "Plan" NOT NULL,
    "reason" "PlanChangeReason" NOT NULL,
    "actorId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditWallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purchasedBalance" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" "CreditGrantSource" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "remaining" DECIMAL(10,2) NOT NULL,
    "periodKey" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "expiredAt" TIMESTAMP(3),

    CONSTRAINT "CreditGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditTransaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "type" "CreditTxType" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "feature" "CreditFeature" NOT NULL,
    "modelId" TEXT,
    "refType" TEXT,
    "refId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "balanceAfter" DECIMAL(10,2) NOT NULL,
    "breakdown" JSONB,
    "paymentId" TEXT,
    "actorId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageCounter" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "metric" "UsageMetric" NOT NULL,
    "periodKey" TEXT NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "metric" "UsageMetric" NOT NULL,
    "delta" INTEGER NOT NULL,
    "feature" TEXT,
    "refId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_userId_key" ON "Subscription"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_providerSubscriptionId_key" ON "Subscription"("providerSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_pendingProviderSubscriptionId_key" ON "Subscription"("pendingProviderSubscriptionId");

-- CreateIndex
CREATE INDEX "Subscription_status_currentPeriodEnd_idx" ON "Subscription"("status", "currentPeriodEnd");

-- CreateIndex
CREATE INDEX "Subscription_status_trialEndsAt_idx" ON "Subscription"("status", "trialEndsAt");

-- CreateIndex
CREATE INDEX "Subscription_status_graceUntil_idx" ON "Subscription"("status", "graceUntil");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_providerOrderId_key" ON "Payment"("providerOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_providerPaymentId_key" ON "Payment"("providerPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_idempotencyKey_key" ON "Payment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Payment_userId_createdAt_idx" ON "Payment"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Payment_subscriptionId_createdAt_idx" ON "Payment"("subscriptionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_eventId_key" ON "WebhookEvent"("eventId");

-- CreateIndex
CREATE INDEX "WebhookEvent_status_receivedAt_idx" ON "WebhookEvent"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "PlanChange_userId_createdAt_idx" ON "PlanChange"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreditWallet_userId_key" ON "CreditWallet"("userId");

-- CreateIndex
CREATE INDEX "CreditGrant_userId_expiresAt_idx" ON "CreditGrant"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreditGrant_userId_source_periodKey_key" ON "CreditGrant"("userId", "source", "periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "CreditTransaction_idempotencyKey_key" ON "CreditTransaction"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CreditTransaction_userId_createdAt_idx" ON "CreditTransaction"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "UsageCounter_updatedAt_idx" ON "UsageCounter"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "UsageCounter_userId_metric_periodKey_key" ON "UsageCounter"("userId", "metric", "periodKey");

-- CreateIndex
CREATE INDEX "UsageEvent_userId_createdAt_idx" ON "UsageEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "UsageEvent_createdAt_idx" ON "UsageEvent"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_razorpayCustomerId_key" ON "User"("razorpayCustomerId");

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanChange" ADD CONSTRAINT "PlanChange_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditWallet" ADD CONSTRAINT "CreditWallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditGrant" ADD CONSTRAINT "CreditGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageCounter" ADD CONSTRAINT "UsageCounter_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: one wallet per existing user (safe to re-run)
INSERT INTO "CreditWallet" ("id", "userId", "purchasedBalance", "updatedAt")
SELECT gen_random_uuid()::text, "id", 0, CURRENT_TIMESTAMP FROM "User"
ON CONFLICT ("userId") DO NOTHING;

-- Existing paid-tier users have no Subscription row (there was no billing
-- before Phase 2). Record their tier as an admin-style grant so the
-- entitlement layer keeps honouring it and the admin tool shows why.
UPDATE "User" SET "planSource" = 'GRANT' WHERE "plan" <> 'FREE' AND "planSource" = 'FREE';
