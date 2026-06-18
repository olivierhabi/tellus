// =====================================================================
// AUTO-GENERATED OSDK — do not edit by hand.
// Ontology: Enterprise Ontology (00000000-0000-0000-0000-000000000001)
// Version: 2026-06-09 12:23:14.108031+00
// Generated at: 2026-06-10T21:15:30.222Z
// Regenerate: npx tsx scripts/osdk-regen.ts --ontology 00000000-0000-0000-0000-000000000001
// =====================================================================

// ----- Object types -------------------------------------------------

/** Business (apiName: "Business", primaryKey: "businessId") */
export interface Business {
  annualRevenue?: number | null;
  businessId: string;
  ebmDeviceCount?: number | null;
  employeeCount?: number | null;
  isVatRegistered?: boolean | null;
  registrationDate?: string | null;
  sector?: string | null;
  tradeName: string;
}

/** Primary-key type of Business (property "businessId"). */
export type BusinessPrimaryKey = string;

/** Customs Declaration (apiName: "CustomsDeclaration", primaryKey: "declarationId") */
export interface CustomsDeclaration {
  declarationId: string;
  declaredValue?: number | null;
  dutyPaid?: number | null;
  hsCode: string;
  importDate?: string | null;
  importerTin?: string | null;
  originCountry?: string | null;
  quantity?: number | null;
}

/** Primary-key type of CustomsDeclaration (property "declarationId"). */
export type CustomsDeclarationPrimaryKey = string;

/** Real Estate Property (apiName: "RealEstateProperty", primaryKey: "propertyId") */
export interface RealEstateProperty {
  district?: string | null;
  location?: { lat: number; lon: number } | string | null;
  ownerTin?: string | null;
  propertyId: string;
  propertyType?: string | null;
  registeredValue?: number | null;
  registrationDate?: string | null;
}

/** Primary-key type of RealEstateProperty (property "propertyId"). */
export type RealEstatePropertyPrimaryKey = string;

/** Taxpayer (apiName: "Taxpayer", primaryKey: "tin") */
export interface Taxpayer {
  complianceStatus?: string | null;
  email?: string | null;
  fullName: string;
  phoneNumber?: string | null;
  province?: string | null;
  registrationDate?: string | null;
  riskScore?: number | null;
  sector?: string | null;
  taxpayerType?: string | null;
  tin: string;
}

/** Primary-key type of Taxpayer (property "tin"). */
export type TaxpayerPrimaryKey = string;

/** Tax Return (apiName: "TaxReturn", primaryKey: "returnId") */
export interface TaxReturn {
  auditFlag?: boolean | null;
  declaredRevenue?: number | null;
  declaredTax?: number | null;
  filingDate: string;
  period?: string | null;
  returnId: string;
  status?: string | null;
  taxType?: string | null;
}

/** Primary-key type of TaxReturn (property "returnId"). */
export type TaxReturnPrimaryKey = string;

// ----- Link types ---------------------------------------------------

export interface LinkTypeDescriptor {
  apiName: string;
  displayName: string;
  cardinality: "ONE_TO_ONE" | "ONE_TO_MANY" | "MANY_TO_ONE" | "MANY_TO_MANY";
  sourceObjectType: string;
  targetObjectType: string;
}

export const LINK_TYPES = {
} as const;

// ----- Action parameter types ---------------------------------------

/** Parameters for action "closeTaxReturn" (Close Tax Return) */
export interface CloseTaxReturnParameters {
  returnRef: string | number; // object_reference → TaxReturn
}

/** Parameters for action "fileTaxReturn" (File Tax Return) */
export interface FileTaxReturnParameters {
  declaredRevenue: number;
  declaredTax: number;
  period: string;
  returnId: string;
  taxType: string;
}

/** Parameters for action "flagForAudit" (Flag Return for Audit) */
export interface FlagForAuditParameters {
  auditReason: string;
  returnRef: string | number; // object_reference → TaxReturn
  taxpayerRef: string | number; // object_reference → Taxpayer
}

/** Parameters for action "registerBusiness" (Register New Business) */
export interface RegisterBusinessParameters {
  businessId: string;
  ownerTin: string | number; // object_reference → Taxpayer
  sector: string;
  tradeName: string;
}

/** Parameters for action "registerTaxpayer" (Register New Taxpayer) */
export interface RegisterTaxpayerParameters {
  fullName: string;
  province?: string;
  taxpayerType: string;
  tin: string;
}

/** Parameters for action "updateTaxpayerRiskScore" (Update Taxpayer Risk Score) */
export interface UpdateTaxpayerRiskScoreParameters {
  riskScore: number;
  taxpayerRef: string | number; // object_reference → Taxpayer
}
