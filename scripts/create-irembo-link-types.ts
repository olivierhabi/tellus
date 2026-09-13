import "dotenv/config";
import linkTypeModel from "../src/models/linkType";

const ontologyId = "00000000-0000-0000-0000-000000000001";

const links = [
  {
    displayName: "[Irembo] Service organization",
    reverseDisplayName: "[Irembo] Organization services",
    cardinality: "MANY_TO_ONE",
    sourceObjectTypeApiName: "IremboGovernmentservice",
    targetObjectTypeApiName: "IremboOrganizationraw",
    sourcePropertyApiName: "organizationId",
    description: "Government service belongs to its source organization via organizationId.",
  },
  {
    displayName: "[Irembo] Service categories",
    reverseDisplayName: "[Irembo] Category service",
    cardinality: "ONE_TO_MANY",
    sourceObjectTypeApiName: "IremboGovernmentservice",
    targetObjectTypeApiName: "IremboServicecategorybridge",
    targetPropertyApiName: "serviceId",
    description: "Government service links to its category bridge rows; one service may have several categories.",
  },
  {
    displayName: "[Irembo] Journey service",
    reverseDisplayName: "[Irembo] Service journeys",
    cardinality: "MANY_TO_ONE",
    sourceObjectTypeApiName: "IremboApplicationjourney",
    targetObjectTypeApiName: "IremboGovernmentservice",
    sourcePropertyApiName: "serviceId",
    description: "Application journey is for one government service via serviceId.",
  },
  {
    displayName: "[Irembo] Journey data source",
    reverseDisplayName: "[Irembo] Data source journeys",
    cardinality: "MANY_TO_ONE",
    sourceObjectTypeApiName: "IremboApplicationjourney",
    targetObjectTypeApiName: "IremboOperationaldatasource",
    sourcePropertyApiName: "sourceId",
    description: "Application journey uses the operational target-source freshness record via sourceId.",
  },
  {
    displayName: "[Irembo] Journey service applications",
    reverseDisplayName: "[Irembo] Service application journey",
    cardinality: "ONE_TO_MANY",
    sourceObjectTypeApiName: "IremboApplicationjourney",
    targetObjectTypeApiName: "IremboServiceapplication",
    targetPropertyApiName: "applicationId",
    description: "Application journey contains its source and observed target ServiceApplication objects via applicationId.",
  },
  {
    displayName: "[Irembo] Journey payments",
    reverseDisplayName: "[Irembo] Payment journey",
    cardinality: "ONE_TO_MANY",
    sourceObjectTypeApiName: "IremboApplicationjourney",
    targetObjectTypeApiName: "IremboPayment",
    targetPropertyApiName: "applicationId",
    description: "Application journey links to payments via applicationId.",
  },
  {
    displayName: "[Irembo] Journey attachment observations",
    reverseDisplayName: "[Irembo] Attachment observation journey",
    cardinality: "ONE_TO_MANY",
    sourceObjectTypeApiName: "IremboApplicationjourney",
    targetObjectTypeApiName: "IremboAttachmentobservation",
    targetPropertyApiName: "applicationId",
    description: "Application journey links to all attachment observations via applicationId for Application 360.",
  },
  {
    displayName: "[Irembo] Journey exceptions",
    reverseDisplayName: "[Irembo] Exception journey",
    cardinality: "ONE_TO_MANY",
    sourceObjectTypeApiName: "IremboApplicationjourney",
    targetObjectTypeApiName: "IremboOperationalexception",
    targetPropertyApiName: "applicationId",
    description: "Application journey links to calculated operational exceptions via applicationId.",
  },
  {
    displayName: "[Irembo] Service application service",
    reverseDisplayName: "[Irembo] Service application records",
    cardinality: "MANY_TO_ONE",
    sourceObjectTypeApiName: "IremboServiceapplication",
    targetObjectTypeApiName: "IremboGovernmentservice",
    sourcePropertyApiName: "serviceId",
    description: "ServiceApplication is for one GovernmentService via serviceId.",
  },
  {
    displayName: "[Irembo] Payment data source",
    reverseDisplayName: "[Irembo] Data source payments",
    cardinality: "MANY_TO_ONE",
    sourceObjectTypeApiName: "IremboPayment",
    targetObjectTypeApiName: "IremboOperationaldatasource",
    sourcePropertyApiName: "sourceId",
    description: "Payment links to the operational target-source freshness record used to interpret institution acknowledgement.",
  },
  {
    displayName: "[Irembo] Observation attachment",
    reverseDisplayName: "[Irembo] Attachment observations",
    cardinality: "MANY_TO_ONE",
    sourceObjectTypeApiName: "IremboAttachmentobservation",
    targetObjectTypeApiName: "IremboAttachment",
    sourcePropertyApiName: "attachmentId",
    description: "Attachment observation belongs to one aggregate Attachment via attachmentId.",
  },
  {
    displayName: "[Irembo] Observation data source",
    reverseDisplayName: "[Irembo] Data source attachment observations",
    cardinality: "MANY_TO_ONE",
    sourceObjectTypeApiName: "IremboAttachmentobservation",
    targetObjectTypeApiName: "IremboOperationaldatasource",
    sourcePropertyApiName: "sourceId",
    description: "Attachment observation links to the source freshness object that governs presence and integrity truth.",
  },
  {
    displayName: "[Irembo] Exception payment",
    reverseDisplayName: "[Irembo] Payment exceptions",
    cardinality: "MANY_TO_ONE",
    sourceObjectTypeApiName: "IremboOperationalexception",
    targetObjectTypeApiName: "IremboPayment",
    sourcePropertyApiName: "paymentId",
    description: "Operational exception optionally refers to the implicated payment via paymentId.",
  },
  {
    displayName: "[Irembo] Exception data source",
    reverseDisplayName: "[Irembo] Data source exceptions",
    cardinality: "MANY_TO_ONE",
    sourceObjectTypeApiName: "IremboOperationalexception",
    targetObjectTypeApiName: "IremboOperationaldatasource",
    sourcePropertyApiName: "sourceId",
    description: "Operational exception links to the data-source freshness record that governed the exception decision.",
  },
  {
    displayName: "[Irembo] Incident dependency",
    reverseDisplayName: "[Irembo] Dependency incidents",
    cardinality: "MANY_TO_ONE",
    sourceObjectTypeApiName: "IremboPlatformincident",
    targetObjectTypeApiName: "IremboExternaldependency",
    sourcePropertyApiName: "dependencyCode",
    description: "Platform incident is attributed to an external dependency via dependencyCode.",
  },
  {
    displayName: "[Irembo] Dependency mapped service",
    reverseDisplayName: "[Irembo] Service dependencies",
    cardinality: "MANY_TO_ONE",
    sourceObjectTypeApiName: "IremboExternaldependency",
    targetObjectTypeApiName: "IremboGovernmentservice",
    sourcePropertyApiName: "mappedServiceId",
    description: "Confirmed dependency mapping links an external dependency to the affected government service.",
  },
] as const;

async function main() {
  const existing = await linkTypeModel.listByOntology(ontologyId);
  const byDisplayName = new Map(existing.map((link) => [link.display_name, link]));

  for (const input of links) {
    const prior = byDisplayName.get(input.displayName);
    if (prior) {
      console.log(`SKIP ${input.displayName} -> ${prior.api_name}`);
      continue;
    }

    const created = await linkTypeModel.create(ontologyId, {
      ...input,
      isBidirectional: true,
      reverseVisible: true,
      violationPolicy: "warn",
    });
    console.log(`CREATED ${created.api_name} | ${created.display_name} | ${created.cardinality}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
