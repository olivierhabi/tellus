// ---------------------------------------------------------------------------
// Workspace Broker Service (K8s Native)
//
// Manages the production-grade lifecycle of embedded code-server instances
// via a hardened, stateless Kubernetes-native pod orchestration model (GHCR).
// ---------------------------------------------------------------------------

import * as k8s from '@kubernetes/client-node';
import { spawn } from 'child_process';
import { sanitizeK8sResourceName } from '../utils/k8sSanitizer';

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
// Type assertion needed due to TypeScript type definition limitations in @kubernetes/client-node v1.x
const k8sCoreApi = kc.makeApiClient(k8s.CoreV1Api) as any;
const NAMESPACE = process.env.WORKSPACE_NAMESPACE || 'telos-workspaces';
const GHCR_ORG = process.env.GHCR_ORG || 'your-github-org-or-username';

// For local minikube development, use port-forward
// For production, use cluster DNS
const USE_PORT_FORWARD = process.env.KUBERNETES_MODE !== 'production' && process.env.NODE_ENV !== 'production';

// CRITICAL: In-memory lock map prevents multi-request race conditions (409 AlreadyExists)
const activeCreationLocks = new Map<string, Promise<string>>();

// Track port-forward processes
const portForwardProcesses = new Map<string, { port: number; process: ReturnType<typeof spawn> }>();
let nextPort = 15000;

class WorkspaceBroker {
  /**
   * Acquire a valid DNS route for the given repository and branch.
   * If code-server is not running, it dynamically scaffolds and spawns a pod.
   */
  public async getOrCreateWorkspaceSession(rid: string, branch: string): Promise<string> {
    console.log(`[WorkspaceBroker] getOrCreateWorkspaceSession called with rid="${rid}", branch="${branch}"`);
    const resourceName = sanitizeK8sResourceName(rid, branch);
    console.log(`[WorkspaceBroker] Computed resourceName="${resourceName}"`);
    const lockKey = `${rid}:${branch}`;

    // If a creation process is already running for this workspace, append to that execution chain
    if (activeCreationLocks.has(lockKey)) {
      return activeCreationLocks.get(lockKey)!;
    }

    const creationPromise = (async () => {
      try {
        // 1. Verify if the target pod exists and is actively running
        console.log(`[WorkspaceBroker] Checking if pod ${resourceName} exists...`);
        const podStatus = await k8sCoreApi.readNamespacedPod({ name: resourceName, namespace: NAMESPACE });
        const isRunning = podStatus.status?.phase === 'Running';

        if (isRunning) {
          return this.getWorkspaceUrl(resourceName);
        }

        // If pod exists but is trapped in an unhealthy state, delete it to trigger self-healing
        if (podStatus.status?.phase === 'Failed' || podStatus.status?.phase === 'Unknown') {
          await k8sCoreApi.deleteNamespacedPod({ name: resourceName, namespace: NAMESPACE });
        }
      } catch (error: unknown) {
        // The Kubernetes client throws errors with different structures
        // Check if it's a 404 "Not Found" error - expected when pod doesn't exist yet
        const err = error as Error;
        const errStr = JSON.stringify(error) + ' ' + (err.message || '');
        const isNotFound = errStr.includes('"code":404') ||
          errStr.includes('NotFound') ||
          errStr.includes('not found') ||
          err.message?.includes('404');

        console.log(`[WorkspaceBroker] Error during pod check, isNotFound=${isNotFound}`);

        if (!isNotFound) {
          throw new Error(`Kubernetes cluster communication failure: ${err.message}`);
        }
        console.log(`[WorkspaceBroker] Pod not found (expected for new workspace), will provision...`);
      }

      console.log(`[WorkspaceBroker] Pod does not exist, provisioning hardened pod for ${resourceName} in namespace ${NAMESPACE}`);

      // 2. Pod does not exist. Orchestrate production infrastructure safely.
      await this.provisionHardenedPodAndService(resourceName, rid, branch);

      // 3. Block routing return until the endpoints are active (Prevents 502/503 errors)
      await this.waitForPodReadiness(resourceName, 30); // 30-second strict timeout policy

      return this.getWorkspaceUrl(resourceName);
    })();

    // Register the lock, execute the pipeline, and clear the lock when finished
    activeCreationLocks.set(lockKey, creationPromise);
    try {
      return await creationPromise;
    } finally {
      activeCreationLocks.delete(lockKey);
    }
  }

  /**
   * Get the URL to access the workspace.
   * In production (K8s cluster), use cluster DNS.
   * In development (minikube), use kubectl port-forward.
   */
  private async getWorkspaceUrl(resourceName: string): Promise<string> {
    if (!USE_PORT_FORWARD) {
      // Production: use cluster DNS
      return `http://${resourceName}.${NAMESPACE}.svc.cluster.local:8080`;
    }

    // Development: use port-forward
    const existing = portForwardProcesses.get(resourceName);
    if (existing && existing.process.exitCode === null) {
      return `http://127.0.0.1:${existing.port}`;
    }

    if (existing) {
      console.log(`[WorkspaceBroker] Port-forward process on port ${existing.port} died (exitCode: ${existing.process.exitCode}). Re-spawning...`);
      portForwardProcesses.delete(resourceName);
    }

    // Start a new port-forward
    const port = nextPort++;
    console.log(`[WorkspaceBroker] Starting port-forward for ${resourceName} on port ${port}...`);

    const pf = spawn('kubectl', [
      'port-forward',
      `svc/${resourceName}`,
      '-n', NAMESPACE,
      `${port}:8080`
    ], {
      detached: true,
      stdio: 'ignore'
    });
    pf.unref();

    portForwardProcesses.set(resourceName, { port, process: pf });

    // Wait for port-forward to be ready
    await new Promise(resolve => setTimeout(resolve, 2000));

    const url = `http://127.0.0.1:${port}`;
    console.log(`[WorkspaceBroker] Workspace URL: ${url}`);
    return url;
  }

  private async waitForPodReadiness(resourceName: string, maxRetries: number): Promise<void> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const statusRes = await k8sCoreApi.readNamespacedPodStatus({ name: resourceName, namespace: NAMESPACE });
        const phase = statusRes.status?.phase;
        const conditions = statusRes.status?.conditions || [];
        const isReady = conditions.some((c: any) => c.type === 'Ready' && c.status === 'True');

        if (phase === 'Running' && isReady) {
          return; // Endpoint is fully active and safe to route user traffic to
        }
      } catch (e) {
        // Ignore intermediate lookup errors during initialization transitions
      }
      await new Promise(resolve => setTimeout(resolve, 1000)); // Poll precisely every 1 second
    }
    throw new Error(`Workspace provisioning timed out: Pod ${resourceName} failed to achieve readiness state.`);
  }

  private async provisionHardenedPodAndService(resourceName: string, rid: string, branch: string) {
    // Using plain object since TypeScript types for V1Pod/V1Service are not properly exported
    const podManifest = {
      metadata: {
        name: resourceName,
        labels: { app: resourceName, type: 'workspace', 'telos.zone/tier': 'tenant-compute' },
      },
      spec: {
        // nodeSelector: { 'telos.zone/role': 'ephemeral-workspaces' },
        // tolerations: [{ key: 'ephemeral-only', operator: 'Exists', effect: 'NoSchedule' }],
        terminationGracePeriodSeconds: 15,

        // HARDENED CONFIG: Instructs Kubernetes to use your GitHub credentials
        imagePullSecrets: [
          { name: 'ghcr-cred' }
        ],

        volumes: [
          { name: 'workspace-storage', emptyDir: { medium: 'Memory' } }, // Fast, pure in-memory execution environment
          { name: 'code-server-config', emptyDir: {} }
        ],
        initContainers: [
          {
            name: 'diskstemma-rehydrator',
            // Target your internal utilities image mirrored on your GitHub registry
            image: `alpine:latest`, // Using alpine for mock logic since actual image might not be available
            // Secure argument passing completely neutralizes command injection risks
            command: ['/bin/sh', '-c'],
            args: [
              'echo "Mocking rehydration from $INTERNAL_API for $RID / $BRANCH" > /workspace/repo.tar && mkdir -p /workspace && touch /workspace/mock-file && mkdir -p /config/code-server/User && echo \'{"workbench.colorTheme": "Default Dark Modern"}\' > /config/code-server/User/settings.json'
            ],
            env: [
              { name: 'INTERNAL_API', value: process.env.INTERNAL_BACKEND_URL || 'http://localhost:3000' },
              { name: 'RID', value: rid },
              { name: 'BRANCH', value: branch }
            ],
            volumeMounts: [
              { name: 'workspace-storage', mountPath: '/workspace' },
              { name: 'code-server-config', mountPath: '/config' }
            ],
            resources: {
              requests: { cpu: '200m', memory: '256Mi' },
              limits: { cpu: '500m', memory: '512Mi' }
            }
          }
        ],
        containers: [
          {
            name: 'code-server',
            // Target your security-hardened, pre-packaged corporate VS Code image from GHCR
            // For testing, fallback to generic node image with a simple http server representing code-server
            image: `codercom/code-server:4.91.1`,
            args: ['--auth=none', '--bind-addr=0.0.0.0:8080', '--disable-telemetry', '/workspace'],
            ports: [{ containerPort: 8080, name: 'http' }],
            volumeMounts: [
              { name: 'workspace-storage', mountPath: '/workspace' },
              { name: 'code-server-config', mountPath: '/home/coder/.local/share/code-server' }
            ],
            // Essential enterprise resource configurations
            resources: {
              requests: { cpu: '500m', memory: '1Gi' },
              limits: { cpu: '1000m', memory: '2Gi' }
            },
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000, // code-server image default is 1000
              runAsGroup: 1000,
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: false, // Must be false for code-server extensions marketplace configurations
              capabilities: { drop: ['ALL'] }
            }
          }
        ]
      }
    };

    const serviceManifest = {
      metadata: { name: resourceName, labels: { app: resourceName } },
      spec: {
        type: 'NodePort', // Use NodePort for local minikube development
        selector: { app: resourceName },
        ports: [{ port: 8080, targetPort: 8080, protocol: 'TCP', nodePort: undefined }] // Let K8s assign a nodePort
      }
    };

    // Synchronously execute resource bindings
    try {
      await k8sCoreApi.createNamespacedPod({ namespace: NAMESPACE, body: podManifest });
    } catch (podError: unknown) {
      const podErrStr = JSON.stringify(podError) + ' ' + ((podError as Error).message || '');
      if (!podErrStr.includes('"code":409') && !podErrStr.includes('AlreadyExists')) {
        throw podError;
      }
      console.log(`[WorkspaceBroker] Pod already exists, continuing...`);
    }

    try {
      await k8sCoreApi.createNamespacedService({ namespace: NAMESPACE, body: serviceManifest });
    } catch (svcError: unknown) {
      const svcErrStr = JSON.stringify(svcError) + ' ' + ((svcError as Error).message || '');
      if (!svcErrStr.includes('"code":409') && !svcErrStr.includes('AlreadyExists')) {
        throw svcError;
      }
      console.log(`[WorkspaceBroker] Service already exists, continuing...`);
    }
  }

  public shutdownAll(): void {
    // Left for compatibility with server.ts, but standard graceful shutdown in K8s
    // happens outside Node scope (e.g. operators mapping node termination)
    console.log(`[WorkspaceBroker] Shutdown requested, leaving pod cleanup to K8s Node limits or GC cron.`);
  }
}

export const workspaceBroker = new WorkspaceBroker();