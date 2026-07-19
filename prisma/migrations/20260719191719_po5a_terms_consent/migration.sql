-- PO-5A — Terms/Privacy consent capture at registration (additive, nullable).
ALTER TABLE "User" ADD COLUMN "acceptedTermsAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "acceptedTermsVersion" TEXT;
