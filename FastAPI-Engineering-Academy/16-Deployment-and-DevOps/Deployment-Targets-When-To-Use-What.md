---
title: "Lesson 06: Deployment Targets – Kubernetes vs Serverless vs VM – When to Use What"
aliases:
 - Deployment targets
 - Kubernetes vs serverless vs VM
 - Deploy strategies
 - Blue-green vs canary vs rolling
 - GitOps vs push-based
tags:
 - deployment
 - kubernetes
 - serverless
 - vm
 - comparison
 - lesson
course_level: advanced
status: complete
difficulty: advanced
estimated_time: "90–120 minutes"
prerequisites:
 - "[[16-Deployment-and-DevOps/Docker-Multi-Stage-Non-Root]]"
 - "[[16-Deployment-and-DevOps/Docker-Compose-Local-Dev]]"
 - "[[16-Deployment-and-DevOps/GitHub-Actions-CI]]"
 - "[[16-Deployment-and-DevOps/Migration-Ordering-and-Rollback]]"
 - "[[03-FastAPI-Core/Application-and-Lifespan]]"
related_lessons:
 - "[[16-Deployment-and-DevOps/Docker-Multi-Stage-Non-Root]]"
 - "[[16-Deployment-and-DevOps/GitHub-Actions-CI]]"
 - "[[16-Deployment-and-DevOps/Migration-Ordering-and-Rollback]]"
 - "[[22-Diagrams/Deployment-Topology]]"
 - "[[19-Interview-Preparation/Production-Incidents-Debugging]]"
---

# Lesson 06: Deployment Targets – Kubernetes vs Serverless vs VM – When to Use What

*The same `Boardly` Docker image — the one you built in Lesson 1, the one CI pushed to `ghcr.io` in Lesson 3 — deployed three ways: on a VM with `docker compose`, on Kubernetes with a `Deployment` + `Service` + `Ingress`, and on Google Cloud Run as a serverless service. Plus the two questions that come right after "where does it run": how do you roll a new version (blue-green vs canary vs rolling) and who triggers the deploy (GitOps vs push-based CI/CD).*

**You're at Lesson 6 of Section 16 — the platform lesson.**

Every senior platform interview has the same shape: "Draw your production architecture on the whiteboard. Where does the container run? How do you roll out a new version? How do you roll back? Who triggers the deploy — the CI pipeline or the cluster?" Four questions. This lesson answers all four by deploying the same image three ways and comparing the three deploy strategies and the two control planes. Take your time. Type every YAML line. Apply every manifest to a local kind cluster. **This is how you learn.**


#deployment #kubernetes #serverless #vm #comparison

## Learning Objectives

By the end of this lesson you will be able to:

1. **Describe the deployment-target spectrum** — VM, Docker on a VM, Kubernetes, serverless / FaaS, managed app platform (Fly.io / Railway / Render) — and name the property that distinguishes each from the next.
2. **Deploy the same `Boardly` Docker image three ways** — on a VM with `docker compose -f compose.prod.yml`, on Kubernetes with a `Deployment` + `Service` + `Ingress`, on Google Cloud Run with `gcloud run deploy`.
3. **Choose between blue-green, canary, and rolling deploys** based on the workload's tolerance for in-flight version mixing and the team's tolerance for infrastructure cost.
4. **Choose between GitOps (Argo CD / Flux) and push-based CI/CD** based on team size, audit requirements, and the number of services being deployed.
5. **Quantify when serverless stops being cheaper** — the steady-state-traffic threshold above which a VM or Kubernetes deployment costs less than per-invocation billing.
6. **Identify when Kubernetes overpays for itself** — the team-size and service-count threshold below which a managed app platform or a single VM is the right answer.
7. **Diagnose the failure modes of each target** — VM single-points-of-failure, Kubernetes operational complexity, serverless cold-start latency and connection limits, managed platform's vendor lock-in.
8. **Recognise the seven classic deployment-target mistakes** — serverless for long-lived connections, Kubernetes for one service, blue-green for risky migrations, canary without observability, GitOps without drift detection, VMs without autoscaling, managed platform for compliance workloads.

## Prerequisites

Before starting, you need:

- **The Dockerfile from Lesson 1** — [[16-Deployment-and-DevOps/Docker-Multi-Stage-Non-Root]]. You should have a working `boardly:0.1.0` image built locally and pushed to `ghcr.io/<your-org>/boardly:0.1.0`. The whole lesson is "where does that image run in production."
- **The compose file from Lesson 2** — [[16-Deployment-and-DevOps/Docker-Compose-Local-Dev]]. The VM variant in this lesson is the same compose file with one target overridden for production.
- **The CI pipeline from Lesson 3** — [[16-Deployment-and-DevOps/GitHub-Actions-CI]]. The push-based deploy model in this lesson is what that CI pipeline produces.
- **The migration deploy job from Lesson 4** — [[16-Deployment-and-DevOps/Migration-Ordering-and-Rollback]]. Every target in this lesson reuses the same `scripts/deploy_migrations.py` one-shot container; the only thing that varies is *where* the container runs.
- **The lifespan lesson** — [[03-FastAPI-Core/Application-and-Lifespan]]. The `/healthz` and `/readyz` endpoints the platform's probes hit are defined there.
- **A local Kubernetes cluster** — `kind` (Kubernetes in Docker) is the easiest; install with `brew install kind` on macOS or follow the official install docs. We will apply manifests against `kind` so you do not have to pay for a cloud cluster to follow along.
- **The `gcloud` CLI** — only if you want to run Variant C (Cloud Run). Reading the manifest is enough if you do not have a GCP project; the comparison does not require a real deploy.

**The most common gap: platform vocabulary.**

Most backend engineers learn Kubernetes by being handed a Helm chart and told "deploy this." The vocabulary — `Deployment`, `Service`, `Ingress`, `HorizontalPodAutoscaler`, `ConfigMap`, `Secret` — gets learned on the job and unevenly. This lesson treats the vocabulary as the *load-bearing* part of the lesson; if you cannot name the primitive, you cannot reason about it. We will define each as we use it.


## The Problem

You pushed `boardly:0.1.0` to `ghcr.io`. The image runs locally under `docker compose up`. The image has a non-root user, a `HEALTHCHECK`, `tini` as PID 1, an exec-form `CMD`. It is the right image. The question is: where does it run in production?

The five options form a spectrum. Each option makes a different trade-off between operational simplicity, cost, scalability, and control:

| Target | Property | When it's right |
|--------|----------|-----------------|
| VM | You rent a Linux box | Smallest footprint, custom kernel, steady low traffic |
| Docker on a VM | Same, but with Docker for reproducibility | Same, plus the image you built in Lesson 1 |
| Kubernetes | You rent a cluster; you declare desired state; the cluster reconciles | 5+ services, multi-region, multi-team |
| Serverless / FaaS | You upload a function or a container; the platform runs it on demand; you pay per invocation | Spiky traffic, no long-lived connections, no cluster to operate |
| Managed app platform (Fly.io, Railway, Render) | Middle ground: container in, URL out, with autoscaling but no control plane to operate | 1–10 services, no full-time SRE, want a Heroku-shaped UX |

The wrong answer is almost always the answer you reach for first. Engineers who have only used Kubernetes reach for Kubernetes even for one service. Engineers who have only used serverless reach for serverless even for steady traffic. The right answer is *the cheapest target that survives your next 12 months of growth*.

The two follow-up questions — *how do you roll a new version* and *who triggers the deploy* — are independent of the target. You can do blue-green on a VM (with two VMs and a load balancer) or on Kubernetes (with two `Deployment`s and a `Service` selector swap). You can do GitOps on any target that has a reconciler. The choices compose. This lesson's last section shows the four reasonable compositions and the one composition that is almost always wrong.

**Note — Historical context — from "pets" to "cattle" to "functions"**

The vocabulary of deployment targets evolved in three waves. (1) **Pets (1995–2010)**: you named your servers, you SSH'd into them, you patched them by hand, you cried when they died. Each server was a snowflake. AWS EC2 in 2006 made "renting a Linux box" a one-line API call but did not change the mental model. (2) **Cattle (2010–2018)**: Kubernetes, Docker Swarm, Mesos. You declared desired state; the cluster reconciled to match. Servers became interchangeable; the cluster was the unit of operations. Kubernetes 1.0 shipped in 2015. By 2018, "container orchestrator" was synonymous with "Kubernetes." (3) **Functions (2018–present)**: AWS Lambda in 2014, Google Cloud Run in 2019, Fly Machines in 2022, Modal in 2023. You do not operate a cluster at all. The platform runs your code on demand and bills you per invocation. The mental model shifted from "I run a service" to "I respond to events." The 2026 consensus, reflected in the engineering blogs of Heroku-shape platforms (Fly.io, Railway, Render) is that *most teams should be on the managed-app-platform middle ground*. Kubernetes is right for the few teams that genuinely need to operate a cluster; serverless is right for the few workloads that are spiky; VMs are right for the few workloads that need custom kernel access. The default is no longer "Kubernetes for everything."


## The Code

Here are the three deployment manifests for the same `boardly:0.1.0` image. Read each through once; we will go line by line afterwards. The three manifests share the same image, the same env vars (passed through Pydantic Settings), the same `/healthz` and `/readyz` endpoints, and the same migration deploy job. What differs is *how the platform schedules the container*.

### Variant A: VM with `docker compose`

```yaml
# compose.prod.yml (Variant A — single VM)
# Run on a VM with: docker compose -f compose.prod.yml up -d
# The image is pulled from ghcr.io; env vars come from /etc/boardly.env
# (which the VM's provisioning tool wrote from the secret store).
services:
  app:
    image: ghcr.io/<your-org>/boardly:0.1.0
    restart: unless-stopped
    env_file:
      - /etc/boardly.env
    ports:
      - "127.0.0.1:8000:8000"  # behind an external reverse proxy
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "--fail", "http://localhost:8000/healthz"]
      interval: 15s
      timeout: 3s
      retries: 5

  postgres:
    image: postgres:17
    restart: unless-stopped
    volumes:
      - postgres_data:/var/lib/postgresql/data
    env_file:
      - /etc/boardly.env
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U boardly"]
      interval: 10s
      timeout: 3s
      retries: 10

  redis:
    image: redis:7
    restart: unless-stopped
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 10

volumes:
  postgres_data:
  redis_data:
```

### Variant B: Kubernetes with `Deployment` + `Service` + `Ingress`

```yaml
# k8s/boardly.yaml (Variant B — Kubernetes)
# Apply with: kubectl apply -f k8s/ -n boardly
# (after `kubectl create namespace boardly`)
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: boardly
  namespace: boardly
  labels:
    app: boardly
spec:
  replicas: 3
  selector:
    matchLabels:
      app: boardly
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    metadata:
      labels:
        app: boardly
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
      containers:
        - name: boardly
          image: ghcr.io/<your-org>/boardly:0.1.0
          ports:
            - containerPort: 8000
          envFrom:
            - secretRef:
                name: boardly-secrets
          readinessProbe:
            httpGet:
              path: /readyz
              port: 8000
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8000
            initialDelaySeconds: 15
            periodSeconds: 20
          lifecycle:
            preStop:
              exec:
                command: ["sh", "-c", "sleep 5"]
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
---
apiVersion: v1
kind: Service
metadata:
  name: boardly
  namespace: boardly
spec:
  selector:
    app: boardly
  ports:
    - port: 8000
      targetPort: 8000
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: boardly
  namespace: boardly
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  tls:
    - hosts: [api.boardly.example.com]
      secretName: boardly-tls
  rules:
    - host: api.boardly.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: boardly
                port:
                  number: 8000
```

### Variant C: Google Cloud Run (serverless)

```yaml
# cloud-run.service.yaml (Variant C — Google Cloud Run)
# Deploy with:
#   gcloud run deploy boardly \
#     --source=. \
#     --region=us-central1 \
#     --ingress=internal-and-cloud-load-balancing \
#     --min-instances=1 \
#     --max-instances=10 \
#     --concurrency=80 \
#     --cpu=1 \
#     --memory=512Mi \
#     --set-env-vars=APP_ENV=production \
#     --set-secrets=APP_DATABASE_URL=boardly-db-url:latest,APP_REDIS_URL=boardly-redis-url:latest
# Or apply the YAML:
#   gcloud run services replace cloud-run.service.yaml
apiVersion: run.googleapis.com/v1
kind: Service
metadata:
  name: boardly
  namespace: "default"
spec:
  template:
    metadata:
      annotations:
        run.googleapis.com/launch-stage: GA
        autoscaling.knative.dev/minScale: "1"   # keep 1 warm to dodge cold starts
        autoscaling.knative.dev/maxScale: "10"
    spec:
      containerConcurrency: 80
      timeoutSeconds: 300
      containers:
        - image: ghcr.io/<your-org>/boardly:0.1.0
          ports:
            - containerPort: 8000
          env:
            - name: APP_ENV
              value: production
            - name: APP_DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: boardly-db-url
                  key: latest
            - name: APP_REDIS_URL
              valueFrom:
                secretKeyRef:
                  name: boardly-redis-url
                  key: latest
          resources:
            limits:
              cpu: "1"
              memory: 512Mi
          livenessProbe:
            httpGet:
              path: /healthz
          startupProbe:
            httpGet:
              path: /readyz
            failureThreshold: 5
            periodSeconds: 10
```

The three manifests are the same application. The difference is one of *who runs the reconciler* — `docker compose` on the VM, the Kubernetes controller-manager in the cluster, or the Cloud Run control plane in GCP.

## Line-by-Line Deep Dive

This section is the heart of the lesson. Read it twice. Don't skip.

### The decision tree, drawn

Before we walk the YAML, draw the decision tree. The diagram below is the mental model to walk away with — every primitive in this lesson maps onto a node on this tree.

```mermaid
flowchart TD
    Start([Where does the container run?]) --> Q1{1 service,<br/>steady traffic?}
    Q1 -->|Yes| Q2{Need a custom<br/>kernel or bare metal?}
    Q1 -->|No, 5+ services or multi-team| K8s[Kubernetes]
    Q2 -->|Yes| VM[VM with docker compose]
    Q2 -->|No, just want a URL| M[Managed platform<br/>Fly.io / Railway / Render]
    Q1 -->|1 service, spiky traffic| Q3{Long-lived<br/>connections<br/>SSE / WS / 10k+?}
    Q3 -->|No| Serverless[Serverless<br/>Cloud Run / Lambda]
    Q3 -->|Yes| K8s
    Q1 -->|Multi-region w/ failover| K8s

    style Start fill:#e1f5ff,stroke:#0288d1
    style Q1 fill:#fff3cd,stroke:#ffc107
    style Q2 fill:#fff3cd,stroke:#ffc107
    style Q3 fill:#fff3cd,stroke:#ffc107
    style VM fill:#d4edda,stroke:#28a745
    style K8s fill:#d4edda,stroke:#28a745
    style Serverless fill:#d4edda,stroke:#28a745
    style M fill:#d4edda,stroke:#28a745
```

**Tip — The decision tree is read top-to-bottom.**

Start at the top. Take the first yes-or-no branch. The leaf you land on is the right answer. If you land on "VM" and your workload also needs autoscaling, you have under-read the tree — re-read the question at "Need a custom kernel?" and go down the managed-platform branch instead.


**Why is serverless not always cheaper?**

Because per-invocation billing math. Cloud Run bills you per request (rounded up to the nearest 100 ms) plus per instance-second. At low traffic (1 req/min), serverless is cheap — you are paying for fractions of an instance. At steady traffic (100 req/s), serverless bills you for 100 requests per second, every second, plus the instance-seconds to serve them. A `c6i.xlarge` VM that handles 100 req/s costs $25/month; the equivalent Cloud Run service costs ~$150/month at the same throughput. The break-even is roughly 5–10 req/s steady-state. Below that, serverless wins. Above that, VM or Kubernetes wins. The 2026 consensus: serverless for spiky workloads (zero traffic at night, 1000 req/s at peak), VM or managed platform for steady workloads (predictable traffic 24/7).


### Variant A: `compose.prod.yml`

```yaml
services:
  app:
    image: ghcr.io/<your-org>/boardly:0.1.0
    restart: unless-stopped
    env_file:
      - /etc/boardly.env
    ports:
      - "127.0.0.1:8000:8000"  # behind an external reverse proxy
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "--fail", "http://localhost:8000/healthz"]
      interval: 15s
      timeout: 3s
      retries: 5
```

**What it does:** Declares the `app` service for the production VM. Pulls the image from `ghcr.io`, restarts unless explicitly stopped, loads env vars from `/etc/boardly.env`, exposes port 8000 on the loopback interface only, gates startup on `postgres` and `redis` being healthy, and runs a `curl`-based healthcheck every 15 seconds.

**Why each line:**

- `image: ghcr.io/<your-org>/boardly:0.1.0` — the same image CI pushed in Lesson 3. The image is identical in every environment. The env vars and the secrets are what differ. This is the contract.
- `restart: unless-stopped` — Docker restarts the container if it crashes or if the VM reboots, but not if you explicitly `docker compose stop` it. This is the right policy for a production container: crashes auto-recover, intentional stops stay stopped.
- `env_file: /etc/boardly.env` — the VM's provisioning tool (Ansible, cloud-init, or a hand-rolled `user-data` script) writes this file from the secret store. Docker reads it and injects the env vars into the container. The container does not know where the env vars came from — it just sees `APP_DATABASE_URL` etc. (See [[04-Pydantic/Pydantic-Settings]].)
- `ports: 127.0.0.1:8000:8000` — *crucially* bound to the loopback interface, not `0.0.0.0`. The container is reachable from the VM itself and from a reverse proxy (NGINX, Caddy) running on the same VM, but not from the public internet directly. The reverse proxy terminates TLS and forwards to `127.0.0.1:8000`. This is the same pattern as the dev compose file from Lesson 2, but the binding is stricter.
- `depends_on: condition: service_healthy` — Docker does not start `app` until `postgres` and `redis` pass their healthchecks. This is the same `service_healthy` condition from Lesson 2.
- `healthcheck: ... /healthz` — Docker marks the container `unhealthy` if `/healthz` fails 5 times in a row. The reverse proxy stops routing to unhealthy containers. (Note: this is a liveness probe, not a readiness probe — `/healthz` says "the process is up and serving", not "I can serve real traffic." See [[03-FastAPI-Core/Application-and-Lifespan]] for the difference.)

**Warning — Don't put `0.0.0.0` in the port binding on a production VM.**

A common mistake is `ports: - "8000:8000"`, which binds to `0.0.0.0` (every interface). On a VM with a public IP, this exposes the container directly to the internet, bypassing the reverse proxy and its TLS termination. Always bind to `127.0.0.1` on a production VM unless you have a specific reason not to. The reverse proxy on the same VM is the only thing that should see port 8000.


**Danger — Security: `X-Forwarded-*` header spoofing via reverse-proxy misconfiguration.**

Binding the container to `127.0.0.1` is only half the ingress defence. The reverse proxy (NGINX, Caddy, Traefik) on the VM must *replace* the `X-Forwarded-For` and `X-Forwarded-Proto` headers from the client, not append to them. A proxy that appends lets an attacker prepend a forged `X-Forwarded-For: 10.0.0.1` to the request — FastAPI/uvicorn then trusts that IP for IP-based rate limits, audit-log attribution, and admin allowlists, and the attacker bypasses all three. The discipline: configure NGINX with `set_real_ip_from 127.0.0.1` (the proxy itself) so it overwrites the header; Caddy with `trusted_proxies 127.0.0.1` for the same effect; Traefik with `forwardingTrusts` set to the loopback. Then on the FastAPI side, run uvicorn with `--proxy-headers --forwarded-allow-ips=127.0.0.1` so the app trusts the headers *only* from the proxy's address — without `--forwarded-allow-ips`, any client can set `X-Forwarded-For` and uvicorn will read it. The CI check: `curl -H 'X-Forwarded-For: 10.0.0.1' https://api.boardly.example.com/admin/users` should return 401 (the IP allowlist is unaffected by the spoofed header), not 200. See [[11-Authentication-and-Security/Threat-Model-First]] for the spoofing threat model and [[03-FastAPI-Core/Middleware-and-Request-Order]] for where uvicorn's `--proxy-headers` lands in the request middleware chain.


**Example — What runs on the VM in addition to `app`, `postgres`, `redis`?**

A reverse proxy (NGINX, Caddy, Traefik) terminates TLS and forwards to `127.0.0.1:8000`. A log shipper (Vector, Fluent Bit) tails the Docker logs and ships them to your log aggregator. A metrics scraper (Prometheus node_exporter) exports VM-level metrics. Optionally, a `migrator` one-shot container runs `scripts/deploy_migrations.py` as part of the deploy. None of these are in the compose file above — they are managed by the VM's provisioning tool, not by `docker compose`. The compose file owns the application; the provisioning tool owns the platform.


### Variant B: Kubernetes `Deployment`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: boardly
  namespace: boardly
  labels:
    app: boardly
spec:
  replicas: 3
  selector:
    matchLabels:
      app: boardly
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
```

**What it does:** Declares a `Deployment` named `boardly` in the `boardly` namespace, with 3 replicas, a label selector matching `app=boardly`, and a `RollingUpdate` strategy with `maxSurge: 1` and `maxUnavailable: 0`.

**Why each line:**

- `kind: Deployment` — a `Deployment` is a Kubernetes primitive that declaratively manages a set of `Pod`s. The `Deployment` controller reconciles the cluster's current state to the desired state: if a Pod crashes, the controller starts a new one; if you change the image tag, the controller rolls the Pods one at a time. The `Deployment` is the unit of replication and rollout.
- `namespace: boardly` — Kubernetes namespaces are a logical partition of the cluster. Putting `boardly` in its own namespace lets you apply `ResourceQuota`s, `NetworkPolicy`s, and `RoleBinding`s at the namespace boundary. In a real cluster, each service gets its own namespace.
- `replicas: 3` — the desired number of Pods. Kubernetes will run 3 Pods across the cluster's nodes. If a node fails, the Pods on it are rescheduled to other nodes; the desired count of 3 is restored. The number 3 is the smallest count that survives a single-node failure with no capacity loss (1 dies, 2 remain, 1 is rescheduled, 3 again).
- `selector: matchLabels: app: boardly` — the `Deployment` selects the Pods it manages by their labels. A Pod with `labels: app: boardly` belongs to this `Deployment`. The selector is immutable after creation in practice — changing it requires deleting and recreating the `Deployment`.
- `strategy: RollingUpdate; maxSurge: 1; maxUnavailable: 0` — when you change the image tag, Kubernetes creates 1 new Pod at a time (`maxSurge: 1`), waits for it to be `Ready`, then terminates 1 old Pod, then creates another new Pod, and so on. `maxUnavailable: 0` means no old Pod is terminated until a new one is `Ready`. This is the **rolling deploy strategy** — one of the three we will compare below.

**When does Kubernetes overpay for itself?**

Three thresholds. (1) **Service count**: less than 5 services, and you are paying the cluster's control-plane cost (3 nodes minimum, etcd backups, RBAC) for very little workload density. (2) **Team size**: less than 5 engineers, and the operational overhead of the cluster (upgrades, certificate rotation, security patching) exceeds the value of the platform. (3) **Multi-region**: if you do not need multi-region with failover, Kubernetes' strengths (federated control, multi-region state) are not being used. Below any of these thresholds, a managed app platform (Fly.io, Railway, Render) gives you 80% of Kubernetes' benefits at 20% of the operational cost. The 2026 default is the managed platform; Kubernetes is the upgrade when you outgrow it.


### Variant B: `Pod` template and probes

```yaml
  template:
    metadata:
      labels:
        app: boardly
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
      containers:
        - name: boardly
          image: ghcr.io/<your-org>/boardly:0.1.0
          ports:
            - containerPort: 8000
          envFrom:
            - secretRef:
                name: boardly-secrets
          readinessProbe:
            httpGet:
              path: /readyz
              port: 8000
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8000
            initialDelaySeconds: 15
            periodSeconds: 20
          lifecycle:
            preStop:
              exec:
                command: ["sh", "-c", "sleep 5"]
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
```

**What it does:** Declares the `Pod` template — the spec of every Pod the `Deployment` will create. The Pod runs as non-root UID 1000, pulls the image, exposes port 8000, loads env vars from a `Secret`, has a `readinessProbe` and a `livenessProbe`, a `preStop` lifecycle hook that sleeps 5 seconds before `SIGTERM`, and has resource requests and limits.

**Why each line:**

- `securityContext: runAsNonRoot: true; runAsUser: 1000; fsGroup: 1000` — Kubernetes enforces that the Pod's container does not run as root. This matches the `USER 1000` line from the Dockerfile in Lesson 1. The `fsGroup` makes the volume mounts writable by GID 1000.
- `envFrom: secretRef: boardly-secrets` — Kubernetes injects every key in the `boardly-secrets` `Secret` as an env var in the container. The `Secret` is created out-of-band (e.g. by `sealed-secrets`, `external-secrets`, or `kubectl create secret`). The container sees `APP_DATABASE_URL` etc. exactly as in Variant A.
- `readinessProbe: httpGet: path: /readyz` — Kubernetes checks `/readyz` every 10 seconds. If it returns 2xx, the Pod is `Ready` and the `Service` routes traffic to it. If it returns non-2xx or times out, the Pod is `NotReady` and the `Service` stops routing to it (but the Pod keeps running). This is how Kubernetes removes a broken Pod from rotation without killing it.
- `livenessProbe: httpGet: path: /healthz` — Kubernetes checks `/healthz` every 20 seconds. If it fails 3 times in a row (default `failureThreshold: 3`), Kubernetes *restarts* the Pod. This is the harder probe — liveness kills the Pod, readiness just unroutes it.
- `lifecycle: preStop: exec: command: ["sh", "-c", "sleep 5"]` — Kubernetes runs this hook *before* sending `SIGTERM` to the container during a Pod termination (rolling deploy, scale-down, or node drain). The 5-second sleep gives the kubelet's endpoint controller and the in-cluster load balancer time to remove the Pod's IP from rotation *before* the container starts draining. Without it, in-flight requests arriving in the ~1–2 second window between `SIGTERM` and endpoint propagation get 502/connection-refused. The `sleep 5` should be tuned to your cluster's endpoint-propagation latency; 5 seconds is the safe default for most managed Kubernetes (GKE, EKS, AKS).
- `resources: requests: cpu: 100m; limits: cpu: 500m` — the Pod requests 100 millicores of CPU (10% of one core) and is allowed to burst up to 500 millicores. The Kubernetes scheduler uses the `requests` to decide which node to place the Pod on; the `limits` are enforced at the cgroup level. The `memory: 128Mi` request and `512Mi` limit follow the same pattern.

**Why the `preStop: sleep 5` hook — the kubelet/endpoint-controller race**

When Kubernetes terminates a Pod (rolling deploy, scale-down, node drain), the sequence is: (1) kubelet sets `Pod.DeletionTimestamp`, (2) kubelet sends `SIGTERM` to the container's PID 1 *immediately*, (3) the endpoint controller (running on the control plane, asynchronously) notices the deletion and removes the Pod's IP from the `EndpointSlice` / `Service` endpoints, (4) the in-cluster load balancer (kube-proxy on each node) picks up the endpoint change and stops routing new connections to the Pod. The race is between step (2) and step (4): `SIGTERM` arrives at the container *before* the LB has stopped routing to it, so new requests keep arriving for 1–5 seconds while the container is trying to drain and shut down. Those requests get 502/connection-refused. The `preStop: exec: command: ["sh", "-c", "sleep 5"]` hook delays `SIGTERM` by 5 seconds — the container keeps serving while the endpoint controller and kube-proxy catch up. By the time `SIGTERM` actually arrives, the LB has stopped routing new traffic, and `uvicorn` (via `tini` — see [[Docker-Multi-Stage-Non-Root]]) can drain its in-flight requests cleanly during the `terminationGracePeriodSeconds` window (default 30 seconds). This is the canonical pattern taught in [[02b-Backend-Foundations/Health-Checks-and-Probes]] ("Mistake 4 — No `preStop` hook").


**Production: tune the `preStop: sleep` value to your cluster's measured endpoint-propagation latency.**

The `sleep 5` in the manifest above is a *safe default*, not a constant. The right value is `max(endpoint_propagation_latency, readiness_probe_period)` for your specific cluster. On managed Kubernetes (GKE, EKS, AKS) the endpoint propagation is ~5–10 seconds; on self-managed k8s with a slow kube-proxy or a remote etcd it can be 15 seconds. Production teams measure the gap with a synthetic rolling-deploy probe — a script that emits one HTTP request every 100 ms to a `/healthz` that returns the Pod's revision, triggers `kubectl rollout restart`, and counts 502s/connection-refused entries between `SIGTERM` (visible as a `preStop` log line) and `Pod deleted` (visible in the kubelet event stream). The 502 count's wall-clock duration is the floor of the `sleep` value; tune the value to `floor + 2s` as a safety margin, never below the floor. A `sleep` value too small re-introduces the kubelet/endpoint-controller race (502s during every rolling deploy); a `sleep` value too large slows down rolling deploys and node drains without buying anything. The synthetic-rolling-deploy probe is the only honest way to size this — vendor defaults are conservative for legal-cover reasons, not for your cluster's actual propagation latency.


**Warning — The readiness/liveness distinction is the whole ballgame.**

A common mistake is to set `readinessProbe` and `livenessProbe` to the same path with the same parameters. The result: a slow query makes `/readyz` return 500, which Kubernetes interprets as "not ready" (good — the Pod is removed from rotation) and then as "unhealthy" (bad — the Pod is killed). The restart wipes the in-flight requests. The right split: `readiness` on `/readyz` (the slow probe that touches the DB), `liveness` on `/healthz` (the fast probe that does not). See [[03-FastAPI-Core/Application-and-Lifespan]] for the implementation.


**Warning — Debugging: the Pod-restarts-in-a-loop symptom that looks like a crash but is a misconfigured liveness probe.**

A Pod that enters `CrashLoopBackOff` is not always crashing — the most common cause on a freshly-deployed FastAPI app is a liveness probe that fails *during lifespan startup*. The liveness probe fires on `periodSeconds: 20` from `initialDelaySeconds: 15`; if lifespan startup (engine pool creation, Redis pool creation, optional migration gate — see [[03-FastAPI-Core/Application-and-Lifespan]]) takes 30 seconds, the liveness probe fails once or twice before the app is ready, the kubelet kills the Pod, the Pod restarts, lifespan startup restarts, the liveness probe fails again, kill, restart, loop — `CrashLoopBackOff`. The debug is `kubectl describe pod -n boardly boardly-...` and read the `Last State: Terminated` block: `Reason: probe failed` (this case), `Reason: Error` (an actual crash — look at `kubectl logs`), and `Reason: OOMKilled` (memory limit hit — see the resource tip below) are three different diagnoses that demand three different fixes. The fix for the liveness case is a `startupProbe` (Kubernetes 1.16+, stable since 1.18) — a third probe that gates *both* liveness and readiness until the first successful startup. With a `startupProbe: httpGet: path: /readyz; failureThreshold: 30; periodSeconds: 5`, the Pod has up to 150 seconds to start before any liveness probe fires, and a slow-starting app is not killed during boot. See [[02b-Backend-Foundations/Health-Checks-and-Probes]] for the three-probe pattern ("Mistake 2 — No `startupProbe`").


**Tip — The resource request is the bill.**

On a cloud-managed Kubernetes cluster (GKE, EKS, AKS), you pay for the nodes, not for the Pods. But the nodes are sized to fit the sum of all Pod `requests`. If every Pod requests 100m CPU and you run 30 Pods, you need 3 cores of node capacity. Bumping the request to 200m means 6 cores of node capacity. The `resources.requests` line is the line that determines your cloud bill. Set it tight; raise it only when a Pod is being throttled.


### Variant B: `Service` and `Ingress`

```yaml
apiVersion: v1
kind: Service
metadata:
  name: boardly
  namespace: boardly
spec:
  selector:
    app: boardly
  ports:
    - port: 8000
      targetPort: 8000
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: boardly
  namespace: boardly
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  tls:
    - hosts: [api.boardly.example.com]
      secretName: boardly-tls
  rules:
    - host: api.boardly.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: boardly
                port:
                  number: 8000
```

**What it does:** Declares a `Service` (a stable network identity that load-balances across the `Deployment`'s Pods) and an `Ingress` (a layer-7 routing rule that maps a hostname + path to a `Service`).

**Why two objects instead of one:** Kubernetes separates "stable in-cluster identity" (`Service`) from "external entry point" (`Ingress`). The `Service` has a stable DNS name (`boardly.boardly.svc.cluster.local`) that other in-cluster services can call. The `Ingress` maps the public hostname to that `Service`. The split lets you change the `Ingress` (e.g. swap the hostname, add a path) without touching the `Service`. It also lets you have multiple `Ingress`es pointing at the same `Service` (e.g. one for the public hostname, one for an internal hostname).

### Variant C: Cloud Run

```yaml
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/minScale: "1"
        autoscaling.knative.dev/maxScale: "10"
    spec:
      containerConcurrency: 80
      timeoutSeconds: 300
      containers:
        - image: ghcr.io/<your-org>/boardly:0.1.0
          ports:
            - containerPort: 8000
          env:
            - name: APP_ENV
              value: production
            - name: APP_DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: boardly-db-url
                  key: latest
          resources:
            limits:
              cpu: "1"
              memory: 512Mi
          livenessProbe:
            httpGet:
              path: /healthz
          startupProbe:
            httpGet:
              path: /readyz
            failureThreshold: 5
            periodSeconds: 10
```

**What it does:** Declares a Cloud Run `Service` (the Cloud Run primitive — confusingly the same name as the Kubernetes `Service`, but a different object) with autoscaling between 1 and 10 instances, 80 concurrent requests per instance, a 5-minute request timeout, the same image, env vars from Secret Manager, and a liveness + startup probe.

**Why each line:**

- `autoscaling.knative.dev/minScale: "1"` — Cloud Run scales to zero by default. Setting `minScale: "1"` keeps one instance warm at all times, which *dodges cold starts* at the cost of paying for one instance 24/7. The trade-off: cold starts cost ~1–3 seconds of latency on the first request after a scale-from-zero; keeping one warm costs ~$15/month for a 512 MiB instance. For a user-facing API, pay the $15. For a webhook receiver, let it scale to zero.
- `containerConcurrency: 80` — Cloud Run routes up to 80 concurrent requests to one instance before scaling out a second. The default is 80; tuning it down (e.g. to 10) makes autoscaling more aggressive — useful if your per-request memory footprint is large (e.g. a streaming response that holds a buffer per connection).
- `timeoutSeconds: 300` — Cloud Run kills requests that take longer than 5 minutes. The default is 5 minutes; the maximum is 60 minutes (as of 2026). If your endpoint serves long-lived SSE streams (Project 06), Cloud Run is *not* the right target — see below.
- `startupProbe` — Cloud Run uses the startup probe to decide when the container is ready to receive traffic. Until the startup probe passes, Cloud Run does not route to the instance. This is important: without it, Cloud Run would route to the container immediately, and the first few requests would fail because lifespan startup has not finished.
- `livenessProbe` — Cloud Run restarts the container if `/healthz` fails. Same semantics as Kubernetes.

**Danger — Cloud Run (and serverless in general) is the wrong target for long-lived connections.**

Cloud Run caps a single request at 60 minutes (as of 2026) and a single instance at 1000 concurrent connections (default 80). Project 06 — [[18-Portfolio-Projects/06-RealTime-Collaboration-Notifications]] — holds 10,000 SSE connections per node. Cloud Run would need 100+ instances to hold 10k connections, and each connection counts against `containerConcurrency` — meaning the autoscaler would scale to the max and stay there, defeating the "scale to zero" benefit. For long-lived-connection workloads, use a VM or Kubernetes. The decision tree at the top of this section routes long-lived-connection workloads away from serverless.


**Danger — Security: mutable image tags are a supply-chain vector — pin by digest.**

The manifests in this lesson reference the image as `ghcr.io/<your-org>/boardly:0.1.0`. The `0.1.0` is a *tag*, and tags are mutable — anyone with push credentials to the registry can re-push `0.1.0` with different (or malicious) content. A stolen personal access token, a leaked service-account key, a compromised CI runner — any of these can overwrite the tag and the next `kubectl apply` pulls the attacker's image. The fix is to reference the image by its *digest*: `image: ghcr.io/<your-org>/boardly@sha256:abc123...`, where the digest is a content-addressable hash of the manifest. A digest is immutable — the same SHA-256 always refers to the same image bytes — and the Kubernetes pull cannot be tricked into pulling something else under the same digest. The discipline: CI resolves the tag to a digest at build time (`docker inspect --format='{{index .RepoDigests 0}}' ghcr.io/<your-org>/boardly:0.1.0`), and the manifests repo holds the digest, not the tag. The supply-chain defence is layered on top: a Sigstore signature on the image, verified by a Kyverno/Cosign admission policy in the cluster, refuses to admit an unsigned digest — so even a stolen token that re-pushes the tag cannot run unless the attacker also has the signing key. See [[11-Authentication-and-Security/OWASP-API-Top-10]] for the supply-chain threat model and the SLSA framework the defence implements.


**Why is serverless not always cheaper? (Quantified.)**

A worked example. `Boardly` handles 100 req/s steady-state. Each request takes 50 ms. Per Cloud Run pricing (verified Oct 2026), you pay $0.00002400 per vCPU-second and $0.00000250 per GiB-second, plus $0.000000400 per request. At 100 req/s, 50 ms each, 1 vCPU, 512 MiB: that's 100 * 0.05 = 5 vCPU-seconds per second of compute = 5 * 0.00002400 = $0.00012/s, plus 0.5 GiB-seconds per second = 0.5 * 0.00000250 = $0.00000125/s, plus 100 req/s = 100 * 0.000000400 = $0.00004/s. Total: $0.00016125/s = $13.97/day = $419/month. A `c6i.xlarge` VM (4 vCPU, 8 GiB) that handles the same 100 req/s costs $25/month. The break-even point in this example is around 5–10 req/s steady-state. Below that, serverless wins on cost; above that, VM or Kubernetes wins. The hidden cost of serverless is the per-request fee that scales linearly with traffic.


### Deploy strategies: rolling, blue-green, canary

Now the second question: *how do you roll a new version?* The three strategies are independent of the target — you can do rolling on a VM (with two containers and a reverse proxy swap), on Kubernetes (with `maxSurge: 1; maxUnavailable: 0`), or on Cloud Run (the default — Cloud Run gradually shifts traffic to the new revision).

| Strategy | What it does | Best for | Costs |
|----------|--------------|----------|-------|
| **Rolling** | Replace instances one at a time; both versions briefly serve traffic simultaneously | Stateless services where the new version is backward-compatible with the old | No extra infra; new version mixed with old for the duration of the roll |
| **Blue-green** | Spin up an identical "green" environment; switch the load balancer; keep "blue" warm for instant rollback | Risky migrations where you want an instant rollback; big-bang releases | 2× infrastructure for the duration of the deploy |
| **Canary** | Route 1% → 5% → 25% → 100% of traffic to the new version; observe; ramp or rollback | Services where the new version's behavior under load is uncertain; A/B features | Requires observability to detect canary failures; rollback is instant |

```mermaid
flowchart LR
 subgraph Rolling
   R1[old v1] -.->|replaced| R2[new v2]
 end
 subgraph BlueGreen
   B1[blue v1] -->|LB swap| B2[green v2]
   B1 -.->|kept warm<br/>for rollback| B3[blue v1 idle]
 end
 subgraph Canary
   C1[v1 99%] -->|LB route| C2[v2 1%]
   C2 -->|observe| C3[v2 5%]
   C3 -->|observe| C4[v2 25%]
   C4 -->|observe| C5[v2 100%]
 end

 style R2 fill:#d4edda,stroke:#28a745
 style B2 fill:#d4edda,stroke:#28a745
 style B3 fill:#fff3cd,stroke:#ffc107
 style C5 fill:#d4edda,stroke:#28a745
```

**Tip — The expand-contract pattern is rolling's pre-requisite.**

Rolling deploy mixes the new and old versions of your code for the duration of the roll. If the new version requires a database column the old version does not write, the two versions will fight. The expand-contract pattern from [[16-Deployment-and-DevOps/Migration-Ordering-and-Rollback]] is what makes rolling deploys safe: the schema is always a superset of what both versions expect. Rolling without expand-contract is the most common cause of 3 a.m. deploys going sideways.


**Warning — Blue-green is not free rollback.**

Blue-green gives you an instant rollback path: switch the load balancer back to the blue environment. But the rollback is *code* rollback, not *schema* rollback. If the green deploy ran a migration that the blue code cannot handle, switching back to blue breaks the system. Blue-green's "instant rollback" assumes the migration was expand-only. The contract phase of the expand-contract pattern has to ship *later*, after you have decided to keep green.


**Production: the blue environment is paid for during the soak window — size the soak, not the environments.**

The blue environment is not free during the green soak; the 2× infrastructure cost is real and the soak window is the variable that bounds it. The production discipline: ship green at the start of the business day, soak for the working day (8 hours), switch the load balancer to green at end of business, keep blue warm until the next morning's standup (one more overnight for confidence), then tear down blue after standup sign-off. The "two environments" line item is paid for *one day*, not indefinitely — the cost of a blue-green deploy is the cost of one environment times the soak duration (e.g. one 3-node Kubernetes cluster for 1 day = ~$10), not the cost of two environments for a release cycle (~$900). The team that pays for two environments indefinitely has misunderstood blue-green — they are running a hot standby, not a deploy strategy. The CI check that enforces this: an Argo CD `PostSync` hook or a GitHub Actions scheduled job that fails the build if a `Deployment` labelled `env: blue` has been `Ready` for more than 48 hours — the soak window is bounded by automation, not by a human remembering to tear down blue. See [[16-Deployment-and-DevOps/Migration-Ordering-and-Rollback]] for the expand-contract contract phase that ships after the soak, which is the moment blue is safe to tear down.


**Example — Canary without observability is just rolling with extra steps.**

A canary that routes 5% of traffic to the new version and then ramps to 100% without checking the canary's error rate is functionally a slow rolling deploy. The point of canary is to *detect* a problem on the 5% before it affects the 100%. Without dashboards on the canary's error rate, latency, and resource usage — without an alert that fires when the canary's metrics diverge from the main — the canary is theatre. Use canary only if your observability stack can detect a 1% difference in error rate in the time the canary is at 1%. See [[13-Performance-and-Observability/Structured-Logging-and-Request-IDs]] and [[13-Performance-and-Observability/OpenTelemetry-Tracing]].


**Warning — Debugging: the canary that looks healthy because its metrics are aggregated with prod's.**

A subtler failure than "no canary dashboard" is "a canary dashboard that aggregates the canary's metrics with prod's." If the canary's error rate is reported as part of the prod aggregate — no `version` label, no `canary` dimension, no `pod_template_hash` partition — then a 30% canary failure rate shows up as a 1.5% blip on the prod dashboard (30% of the 5% canary share), well below a typical 5% alert threshold, and the canary ramps to 25% before anyone notices. The debug: when the canary looks healthy but prod's aggregate has a small unexplained uptick, check the PromQL/LogQL — `rate(http_requests_total{status="5xx"}[1m])` lumps everything; `sum by (version) (rate(http_requests_total{status="5xx"}[1m]))` partitions. Without per-version partition, the canary is invisible in the aggregate by construction. The fix is a label on every metric from the start (`version`, `pod_template_hash`, `revision`) — added by the OpenTelemetry SDK's resource detector, not by hand-instrumented log lines — and an alert rule that compares `rate(http_requests_total{version="canary",status="5xx"}[1m]) / rate(http_requests_total{version="canary"}[1m])` to the prod baseline, firing at a 2x divergence. The canary alert must be a *ratio* on the canary's own traffic, not an absolute count on the prod aggregate — otherwise a healthy canary under low traffic false-alarms and a sick canary under high traffic is missed. See [[13-Performance-and-Observability/OpenTelemetry-Tracing]] for the resource-detector pattern that adds the `version` label to every span and metric without per-call instrumentation.


### GitOps vs push-based CI/CD

The third question: *who triggers the deploy?* Two answers.

**Push-based (what we built in Lesson 3).** The CI pipeline (GitHub Actions) builds the image, pushes it to the registry, then runs `kubectl apply -f k8s/` (or `gcloud run deploy` or `ssh prod-vm 'docker compose pull && docker compose up -d'`) as the last step. The deploy is triggered from outside the cluster.

```mermaid
flowchart LR
    Dev[Developer] -->|git push| GitHub[GitHub]
    GitHub -->|trigger| GHA[GitHub Actions CI]
    GHA -->|build & push| GHCR[ghcr.io]
    GHA -->|kubectl apply| Cluster[Prod cluster]
    GHA -->|ssh + compose pull| VM[Prod VM]
    GHA -->|gcloud run deploy| CR[Cloud Run]

    style Dev fill:#e1f5ff,stroke:#0288d1
    style GHA fill:#fff3cd,stroke:#ffc107
    style GHCR fill:#d1ecf1,stroke:#17a2b8
    style Cluster fill:#d4edda,stroke:#28a745
    style VM fill:#d4edda,stroke:#28a745
    style CR fill:#d4edda,stroke:#28a745
```

**GitOps (pull-based).** The CI pipeline builds the image and pushes it to the registry. *Then* it commits a one-line change to a separate Git repo (the "manifests repo") that updates the image tag in `k8s/boardly.yaml`. Argo CD or Flux runs *inside* the cluster, watches the manifests repo, and reconciles the cluster to match. The deploy is triggered from inside the cluster.

```mermaid
flowchart LR
    Dev[Developer] -->|git push| GitHub[GitHub]
    GitHub -->|trigger| GHA[GitHub Actions CI]
    GHA -->|build & push| GHCR[ghcr.io]
    GHA -->|bump image tag| ManifestsRepo[manifests repo]
    ManifestsRepo -->|watch| ArgoCD[Argo CD in cluster]
    ArgoCD -->|reconcile| Cluster[Prod cluster]
    Dev -.->|git revert| ManifestsRepo
    ManifestsRepo -.->|watch| ArgoCD
    ArgoCD -.->|reconcile: rollback| Cluster

    style Dev fill:#e1f5ff,stroke:#0288d1
    style GHA fill:#fff3cd,stroke:#ffc107
    style GHCR fill:#d1ecf1,stroke:#17a2b8
    style ManifestsRepo fill:#fff3cd,stroke:#ffc107
    style ArgoCD fill:#fce4ec,stroke:#c2185b
    style Cluster fill:#d4edda,stroke:#28a745
```

The difference is *who has deploy credentials to the cluster*.

- **Push-based**: the CI runner has `kubectl` credentials (or `gcloud` credentials, or SSH keys to the VM). A compromise of the CI pipeline is a compromise of prod. The audit trail is the CI run; the desired state lives in the CI run's parameters.
- **GitOps**: the CI runner has *no* credentials to the cluster. It only has push access to the manifests repo. Argo CD, running *inside* the cluster, has the credentials. A compromise of the CI pipeline can push bad images to the registry and bump the manifests repo, but it cannot directly apply to the cluster — Argo CD will reconcile, but a `git revert` on the manifests repo undoes the change. The audit trail is the manifests repo's git history; the desired state lives in a Git repo.

**The trade-off is the audit surface, not the speed.**

Both strategies reach the cluster in the same time (the image build is the slow step; the apply is fast). The difference is the blast radius of a CI compromise. With GitOps, a compromised CI runner cannot deploy to prod directly — it can only push images and bump manifests, both of which are visible in Git history and reversible with `git revert`. With push-based, a compromised CI runner *is* a prod compromise.


**Tip — When to pick which.**

Push-based for small teams (1–5 services, single environment, no compliance requirement). GitOps for platform teams operating many services with audit requirements (SOC 2, FedRAMP, ISO 27001). The transition is gradual: start push-based, add Argo CD as a *watcher* alongside the existing pipeline (Argo CD will reconcile to match what CI applied), then remove the CI's `kubectl` credentials and rely on Argo CD alone. The last step is the moment you are "doing GitOps."


## Execution Trace

Time to apply Variant B (Kubernetes) to a local `kind` cluster. In your terminal:

```bash
# Install kind if you don't have it.
brew install kind

# Create a cluster.
kind create cluster --name boardly

# Point kubectl at it.
kubectl config use-context kind-boardly

# Create the namespace.
kubectl create namespace boardly

# Create the Secret (use real values in production; this is a placeholder).
kubectl create secret generic boardly-secrets \
    --namespace=boardly \
    --from-literal=APP_DATABASE_URL='postgresql+asyncpg://boardly:dev@postgres.boardly.svc.cluster.local:5432/boardly' \
    --from-literal=APP_REDIS_URL='redis://redis.boardly.svc.cluster.local:6379/0' \
    --from-literal=APP_ENV='production'

# Apply the manifests.
kubectl apply -f k8s/ -n boardly

# Watch the rollout.
kubectl rollout status deployment/boardly -n boardly
```

What happens, in order:

1. **`kubectl apply`** sends the three manifests (`Deployment`, `Service`, `Ingress`) to the Kubernetes API server.
2. **The API server validates** each manifest against the schema for its `kind`. A typo (e.g. `repicas: 3` instead of `replicas: 3`) is rejected here.
3. **The `Deployment` controller** (running in the cluster's control plane) sees the new `Deployment` and creates 3 `Pod`s per the template.
4. **The scheduler** places each `Pod` on a node. In `kind`, there is one node; in a real cluster, the scheduler would spread the 3 Pods across 3 nodes for fault tolerance.
5. **The `kubelet`** on each node pulls the image from `ghcr.io`, starts the container, and begins running the `readinessProbe`.
6. **The lifespan runs** — `Boardly starting up...` is printed, the SQLAlchemy engine pool is created, the Redis pool is created. (See [[03-FastAPI-Core/Application-and-Lifespan]].)
7. **The `readinessProbe`** (`/readyz`) starts passing — the Pod is `Ready`.
8. **The `Service`** starts routing traffic to the `Ready` Pods.
9. **The `Ingress` controller** (e.g. nginx-ingress) reads the `Ingress` manifest and configures its load balancer to route `api.boardly.example.com` → `boardly` `Service`.
10. **The reverse proxy** (the `Ingress` controller) starts forwarding HTTP requests to the `Service`'s `ClusterIP`.

```mermaid
sequenceDiagram
    participant K as kubectl
    participant API as Kubernetes API
    participant D as Deployment ctrl
    participant S as Scheduler
    participant N as Node 1 kubelet
    participant P as Pod container
    participant L as Lifespan

    K->>API: apply Deployment
    API->>D: reconcile
    D->>S: schedule 3 Pods
    S->>N: place Pod 1 here
    N->>API: bind Pod to node
    N->>P: pull image then start container
    P->>L: ASGI lifespan.startup
    L->>L: create engine, redis pool
    L-->>P: yield (ready)
    N->>P: readinessProbe /readyz -> 200
    N->>API: Pod Ready
    API->>D: 3/3 Pods Ready
    D-->>K: rollout complete

```

**You just deployed to Kubernetes.**

The same image that runs on the VM (Variant A) and on Cloud Run (Variant C) just ran on Kubernetes. The image did not change. The manifests described *how* the platform should run it. The platform did the work. That is the whole point of containers: the contract between the developer and the operator is the image; everything else is configuration.


## Common Mistakes

### Mistake 1: Serverless for long-lived connections

```
# WRONG: deploy Project 06 (10k SSE connections per node) to Cloud Run.
```

**Symptom:** Cloud Run scales to the max (`maxScale: 1000`), the bill is $5,000/month, and the autoscaler is never satisfied. Cold starts on new instances drop SSE frames; clients reconnect in a thundering herd.

**Why:** Cloud Run (and serverless in general) bills per request and per instance-second. Long-lived connections hold an instance open at the per-instance connection limit, defeating the scale-to-zero benefit and paying per-instance-second for the entire duration of the connection. SSE and WebSocket are the worst fit for serverless.

**Fix:** Move long-lived-connection workloads to a VM or Kubernetes. The decision tree at the top of this lesson routes "long-lived connections, 10k+ per node" away from serverless. See [[18-Portfolio-Projects/06-RealTime-Collaboration-Notifications]] for the workload shape.

### Mistake 2: Kubernetes for one service

```
# WRONG: a 3-engineer team with one FastAPI service deploys to GKE Autopilot.
```

**Symptom:** The team spends 30% of their time on Kubernetes operational concerns (upgrading the cluster, fixing RBAC, debugging `Ingress` routing) and 70% on the application. The cluster is the second-largest line item on the cloud bill after the database.

**Why:** Kubernetes' benefits (multi-service density, multi-region failover, declarative reconciliation, horizontal pod autoscaling) are not being used at one service. The operational cost is real and constant; the benefit is zero.

**Fix:** Move to a managed app platform (Fly.io, Railway, Render). The same Docker image runs there. The operational cost drops to ~0. The per-service cost is $10–25/month. Re-evaluate Kubernetes when you have 5+ services or a multi-region requirement.

### Mistake 3: Blue-green for risky migrations

```
# WRONG: a migration that drops a column, deployed with blue-green.
```

**Symptom:** The green environment runs the new code (which expects the column to be gone) and the migration drops the column. You discover a bug in green. You switch the load balancer back to blue. Blue crashes — the blue code expects the column to be there, but the column is gone.

**Why:** Blue-green's "instant rollback" is *code* rollback, not *schema* rollback. A migration that drops a column cannot be rolled back by switching the load balancer; the schema change is irreversible from blue's perspective.

**Fix:** Use the expand-contract pattern from [[16-Deployment-and-DevOps/Migration-Ordering-and-Rollback]]. The drop phase (contract) ships in a *later* deploy, after you have decided to keep green. Blue-green is right for risky *code* changes; it is wrong for risky *schema* changes.

### Mistake 4: Canary without observability

```
# WRONG: canary 5% of traffic to the new version; no alerts on canary error rate.
```

**Symptom:** The new version is broken — it 500s on 30% of requests. The canary's 5% share has the same 30% failure rate. Without a dashboard on the canary's error rate, no one notices for 4 hours. The ramp to 25% happens; prod's error rate spikes to 7.5%. The team gets paged.

**Why:** Canaries only work if you *detect* the canary's failure. Detection requires observability — error rate, latency, resource usage, business metrics — partitioned by version. Without that partition, the canary's failures are invisible.

**Fix:** Add dashboards on the canary's metrics before deploying. Add alerts that fire when the canary's metrics diverge from the main. The observability stack from [[13-Performance-and-Observability/OpenTelemetry-Tracing]] and [[13-Performance-and-Observability/Structured-Logging-and-Request-IDs]] is the prerequisite.

### Mistake 5: GitOps without drift detection

```
# WRONG: Argo CD is installed; nobody checks whether the cluster has drifted.
```

**Symptom:** A team member `kubectl apply`s a hotfix directly to the cluster. The hotfix is not in the manifests repo. Argo CD does not reconcile because it is set to `AutoSync: false` (manual sync). Six months later, a deploy reverts the hotfix; the bug returns in prod.

**Why:** GitOps' audit trail is only useful if the cluster is *actually* in sync with the manifests repo. Drift happens when humans `kubectl apply` directly. Without drift detection, drift accumulates silently until the next deploy.

**Fix:** Two options. (1) Set Argo CD to `AutoSync: true` — every drift is immediately reverted, which prevents hotfixes via `kubectl`. (2) Run a periodic drift-detection job (e.g. `argocd app diff`) and alert on any drift. The team chooses between "no hotfixes" and "hotfixes with a 24-hour SLA to commit them to the manifests repo." Both are valid; both require drift detection.

### Mistake 6: VMs without autoscaling

```
# WRONG: a single VM, no autoscaling group, 100% of the traffic.
```

**Symptom:** The VM dies at 3 a.m. The on-call is paged. The service is down for 45 minutes while a new VM is provisioned, the image is pulled, the migrations are run, and traffic is rerouted.

**Why:** A single VM is a single point of failure. Autoscaling groups (AWS ASG, GCP MIG) maintain a desired count of VMs and replace failed ones automatically. Without an ASG, the VM has no automatic recovery.

**Fix:** Either (a) put the VM in an ASG with min=2 max=2 across two availability zones (cheap, single-region, survives a single-AZ failure), or (b) move to Kubernetes where the cluster handles the replacement. A single VM is acceptable for development; it is not acceptable for production traffic.

### Mistake 7: Managed platform for compliance workloads

```
# WRONG: HIPAA-regulated healthcare workload on Fly.io.
```

**Symptom:** Fly.io does not sign a BAA (Business Associate Agreement) for HIPAA. The workload is non-compliant. The audit fails. The contract is lost.

**Why:** Managed app platforms (Fly.io, Railway, Render) are not all HIPAA/SOC 2/FedRAMP compliant. Their shared-tenancy model and their refusal to sign BAAs make them unsuitable for regulated workloads.

**Fix:** Use a target that supports the compliance regime — typically a single-tenant VM or a dedicated Kubernetes cluster. The compliance cost is real; the platform choice has to match it.

**Warning — The compliance check is per-target, per-regime.**

AWS, GCP, and Azure are HIPAA-eligible (with a BAA). Fly.io is HIPAA-eligible as of 2024 (with a BAA on the dedicated-capacity plan). Railway and Render are *not* HIPAA-eligible as of 2026-10. Check the platform's compliance page *before* you commit to it. The cost of a wrong compliance choice is the contract, not the bill.


## Engineering Trade-Offs

### VM vs. Kubernetes vs. serverless: the cost/operations matrix

| Target | Per-month cost at 100 req/s steady | Operational cost | Cold-start latency | Long-lived connections | Compliance |
|--------|-------------------------------------|------------------|---------------------|------------------------|------------|
| VM (single, ASG=2) | $25–50 | Low (patching, healthchecks) | 0 (always warm) | Excellent | Good (with single-tenant) |
| Kubernetes (3-node) | $150–300 | High (cluster ops, cert rotation) | 0 (always warm) | Excellent | Excellent |
| Serverless (Cloud Run) | $150–500 at steady; $5 at spiky | Low (no cluster to operate) | 1–3 s on scale-from-zero | Poor (per-instance conn limits) | Good (HIPAA, SOC 2) |
| Managed platform (Fly.io) | $25–50 | Very low | 0 (with min_scale=1) | Good | Mixed (Fly HIPAA-eligible, Render not) |

The right answer is rarely "the cheapest" or "the most scalable." It is "the target whose cost shape and operational profile match your workload for the next 12 months."

### Blue-green vs canary vs rolling: the strategy matrix

| Strategy | Extra infra during deploy | Rollback speed | Failure-detection requirement | Risky for |
|----------|---------------------------|-----------------|---------------------------------|-----------|
| Rolling | None | Slow (re-roll) | Low — both versions serve traffic | Incompatible versions |
| Blue-green | 2× | Instant (LB swap) | Low — green is fully observed before swap | Schema changes that drop |
| Canary | None | Instant (route 0%) | High — observability on canary | Workloads where 1% of traffic can cause outsized harm |

The default is rolling. Blue-green is for risky code changes (and not for risky schema changes — see Mistake 3). Canary is for changes whose behavior under load is uncertain (and only if observability is in place — see Mistake 4).

### GitOps vs push-based: the audit matrix

| Property | Push-based CI/CD | GitOps (Argo CD / Flux) |
|----------|-------------------|--------------------------|
| Deploy trigger | CI runner invokes `kubectl apply` | Argo CD watches manifests repo |
| Credentials | CI has cluster credentials | Cluster has internal credentials; CI does not |
| Audit trail | CI run logs | Git history of manifests repo |
| Rollback | Re-run the CI job with the old image tag | `git revert` on the manifests repo |
| Operational cost | None — already have CI | Medium — Argo CD is itself a service to operate |
| Right for | 1–5 services, small team, no compliance requirement | 5+ services, multi-team, audit requirement |

The transition is gradual: start push-based, add Argo CD as a watcher, then remove CI's `kubectl` credentials. The 2026 default is push-based for small teams; GitOps for platform teams.

## Exercises

**Tip — The 20-minute rule**

If you're stuck on an exercise for more than 20 minutes, re-read the relevant section above, then move on and come back. Learning isn't linear.


**Exercise 1 — Deploy Variant B to `kind`.** Install `kind`. Create a cluster. Apply the three manifests from Variant B. Run `kubectl rollout status deployment/boardly`. Verify the Pods are `Ready`. Port-forward with `kubectl port-forward svc/boardly 8000:8000 -n boardly` and `curl http://localhost:8000/healthz`. You should see `{"status":"ok"}`.

**Exercise 2 — Trigger a rolling deploy.** Change the image tag in the `Deployment` from `0.1.0` to `0.1.1` (or change a label). Apply. Watch `kubectl rollout status deployment/boardly` — it should report "1 of 3 updated" then "2 of 3" then "3 of 3". Roll back with `kubectl rollout undo deployment/boardly`. Verify the original tag is back.

**Exercise 3 — Quantify serverless for your workload.** Take the production traffic of a service you work on (or estimate: peak req/s, steady req/s, request latency, memory per request). Use Cloud Run's pricing page to compute the monthly bill. Compare to the cost of a VM that handles the same peak req/s. Identify the break-even traffic level. If your steady traffic is above the break-even, serverless is the wrong choice.

**Exercise 4 — Design a canary with observability.** Pick a workload. Design a canary: 1% → 5% → 25% → 100%. List the metrics you need to monitor on the canary (error rate, p99 latency, CPU, memory, business metrics). Specify the alert thresholds that would auto-rollback the canary. Specify what would *not* trigger a rollback (so you don't false-alarm). This exercise makes the "canary without observability is theatre" claim concrete.

**Exercise 5 — Migrate from push-based to GitOps.** Take the CI pipeline from Lesson 3. Add a step that bumps the image tag in a manifests repo (a second Git repo, separate from the app repo). Install Argo CD in your `kind` cluster. Point Argo CD at the manifests repo. Verify that pushing a new image tag to the manifests repo triggers a reconcile and a rollout. Remove the CI pipeline's `kubectl` credentials (it no longer needs them). The pipeline now only builds images and bumps manifests; Argo CD does the deploy.

**Exercise 6 — Spot the deployment mistake.** A team runs 5,000 SSE connections per node on Cloud Run, with `maxScale: 100`. They are paying $4,000/month and the autoscaler is at the max constantly. Their cold-start rate is high because the autoscaler is scaling new instances on every connection burst. Name the mistake. Name the right target. Name the expected monthly cost on the right target. (Spoiler: long-lived-connection workload on serverless; move to Kubernetes or VM; expected cost ~$150/month on a 3-node Kubernetes cluster or ~$50/month on a single VM with ASG=2.)

**Exercise 7 — Reproduce the `preStop: sleep 5` race.** In your `kind` cluster (which is itself Docker-hosted — `kind` = "Kubernetes in Docker"), deploy Variant B from the lesson. Patch the Deployment to remove the `preStop` hook: `kubectl patch deployment boardly -n boardly --type=json -p='[{"op":"remove","path":"/spec/template/spec/containers/0/lifecycle"}]'`. Start a continuous request loop in another terminal: `while true; do curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8000/healthz; done`. Trigger a rolling deploy: `kubectl rollout restart deployment/boardly -n boardly`. Count the 502/connection-refused entries during the rollout (the loop prints `000` or `502` instead of `200`). Re-add the `preStop: exec: command: ["sh", "-c", "sleep 5"]` hook. Trigger another rolling deploy. Count the 502s — they should drop to near-zero. Verify the cluster is docker-hosted with `docker ps | rg kindd-control-plane` and the rollout status with `kubectl rollout status deployment/boardly -n boardly`. The exercise is the kubelet/endpoint-controller race made measurable — the difference between the two runs is the value of the `preStop` hook.

**Exercise 8 — Reproduce the liveness-restart loop.** Deploy Variant B with `livenessProbe.initialDelaySeconds: 5` (too short — lifespan startup takes longer than 5 seconds in this configuration; bump the lifespan's work or add an artificial `await asyncio.sleep(20)` to make the failure visible). Confirm the Pod enters `CrashLoopBackOff`. Debug with `kubectl describe pod -n boardly -l app=boardly` — read the `Last State: Terminated` block: `Reason` should be `started`/`probe failed` (not `OOMKilled` and not `Error`). Fix by adding a `startupProbe` (`httpGet: path: /readyz`, `failureThreshold: 30`, `periodSeconds: 5`) so the liveness probe does not fire until the startup probe passes. Confirm the Pod reaches `Ready` and stays there. Verify the cluster is the docker-hosted kind cluster with `docker ps | rg kindd-control-plane` and the Pod status with `kubectl get pods -n boardly -w` (the watch should show `Running` stable, no restart counter incrementing). The exercise is the three-probe pattern from the `**Warning — Debugging: the Pod-restarts-in-a-loop**` callout above — `startupProbe` is the fix.

**Exercise 9 — Quantify per-version metric partition.** Deploy two versions of the image (`0.1.0` and `0.1.1`) as two Deployments behind one Service (a canary shape, with `version: v1` and `version: v2` labels). Run a local Prometheus in Docker: `docker run --rm -d --name ci-prom -p 9090:9090 prom/prometheus:latest`. Emit a metric `http_requests_total{status,version}` from the app. Write a PromQL that aggregates across all versions: `sum(rate(http_requests_total[1m]))`. Write a PromQL that partitions by version: `sum by (version) (rate(http_requests_total[1m]))`. Inject 30% failures on version `0.1.1` (a feature flag that returns 500 on 30% of requests). Confirm the aggregate query shows ~3% (30% of 10%) — below a typical 5% alert threshold — while the partitioned query shows 30%. This is the "canary without partition is theatre" demo from the `**Warning — Debugging: the canary that looks healthy**` callout. Verify the metric is being scraped with `uv run python -c "import requests; r=requests.get('http://localhost:9090/api/v1/query', params={'query': 'sum by (version) (rate(http_requests_total[1m]))'}); print(r.json())"` and the docker-hosted Prometheus with `docker ps | rg prometheus`.

**Exercise 10 — Image digest pinning vs mutable tags.** Build the image with `docker build -t boardly:0.1.0 .` and push to a local registry: `docker run -d -p 5000:5000 --name ci-registry registry:2 && docker push localhost:5000/boardly:0.1.0`. Inspect the manifest: `docker manifest inspect localhost:5000/boardly:0.1.0` — note the `sha256` digest. Re-tag a *different* image to the same tag: `docker tag alpine:latest localhost:5000/boardly:0.1.0 && docker push localhost:5000/boardly:0.1.0`. Confirm the digest changed — the tag is mutable, and a stolen-credentials attacker could do the same to your prod registry. Re-pull: `docker pull localhost:5000/boardly:0.1.0` — you now have alpine, not Boardly. Fix by referencing the digest directly in the Deployment: `image: localhost:5000/boardly@sha256:<original-digest>`. Verify with `kubectl apply -f k8s/ -n boardly && kubectl get pods -n boardly` (the Pod pulls the digest, not the tag — `alpine` cannot sneak in even if the tag is re-pushed). The exercise is the supply-chain defence from the `**Danger — Security: mutable image tags**` callout above — the digest is the immutable content-addressable reference the tag should have been.

**Exercise 11 — Cost-model the blue-green soak window.** Pick a workload (use Boardly's traffic: 100 req/s steady, 50 ms latency, 512 MiB memory, 1 vCPU). Write a `scripts/cost_model.py` that takes `--strategy` (blue-green | canary), `--duration` (in days), `--instances` (per environment), and prints the dollar cost using Cloud Run pricing ($0.00002400/vCPU-s, $0.00000250/GiB-s, $0.000000400/req — verified Oct 2026). Compare blue-green (2× infrastructure for the soak duration — say 1 day) vs canary (1× infrastructure with 5% of traffic on the new version for the same duration). The exercise is the dollar comparison, not the deploy — the goal is to internalise that blue-green's "instant rollback" is bought with 2× infrastructure for the duration of the soak, not indefinitely. Verify with `uv run python scripts/cost_model.py --strategy blue-green --duration 1 --instances 3` and `uv run python scripts/cost_model.py --strategy canary --duration 1 --instances 3 --canary-pct 5`. The numbers should show blue-green costs ~2× canary for a 1-day soak; if canary costs more, your soak window is too long for canary's observability ramp.

**Exercise 12 — Argo CD drift detection via docker-CLI.** Install Argo CD in your `kind` cluster: `kubectl apply -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml -n argocd` (the cluster itself is docker-hosted via `kind`). Apply the manifests repo. Manually drift the cluster: `kubectl scale deployment boardly -n boardly --replicas=5` (the manifests repo says 3). Run the Argo CD CLI via docker (no local install needed): `docker run --rm --network=host argoproj/argocd:latest argocd app diff boardly --server localhost:8080 --plaintext --insecure` — confirm it reports the drift (replicas: 3 declared, 5 actual). Set Argo CD to `AutoSync: true` (in the Argo CD UI or via `argocd app set boardly --sync-policy auto`). Confirm the drift is auto-reverted (replicas returns to 3 within seconds). Now drift with `kubectl set image deployment boardly boardly=alpine:latest -n boardly`. Confirm Argo CD reverts it. Verify the docker-hosted cluster with `docker ps | rg kindd-control-plane` and the replica count with `kubectl get deployment boardly -n boardly -o jsonpath='{.spec.replicas}{"\n"}'` (should be `3`, not `5`). The exercise is the GitOps-without-drift-detection mistake (Mistake 5) made operational — the drift-detection job is the defence, the docker-CLI invocation is how a small team runs it without installing the Argo CD binary on every developer's laptop.

## Verification

Run the local Kubernetes deploy from Variant B and verify each step:

```bash
# Cluster is up.
kubectl cluster-info --context kind-boardly
# Expect: Kubernetes control plane is running at https://127.0.0.1:...

# Namespace is created.
kubectl get namespace boardly
# Expect: boardly   Active   2m

# Deployment is created.
kubectl get deployment -n boardly boardly
# Expect: boardly   3/3   3   3   2m

# Pods are Ready.
kubectl get pods -n boardly -l app=boardly
# Expect: boardly-...   1/1   Running   0   2m  (3 of these)

# Service is created.
kubectl get service -n boardly boardly
# Expect: boardly   ClusterIP   10.96.x.x   <none>   8000/TCP   2m

# Port-forward and hit /healthz.
kubectl port-forward svc/boardly 8000:8000 -n boardly
curl http://localhost:8000/healthz
# Expect: {"status":"ok"}

# Trigger a rolling deploy.
kubectl set image deployment/boardly boardly=ghcr.io/<your-org>/boardly:0.1.1 -n boardly
kubectl rollout status deployment/boardly -n boardly
# Expect: deployment "boardly" successfully rolled out

# Roll back.
kubectl rollout undo deployment/boardly -n boardly
kubectl rollout status deployment/boardly -n boardly
# Expect: deployment "boardly" successfully rolled out
```

If you see `{"status":"ok"}` from `curl http://localhost:8000/healthz`, your Kubernetes deploy works. If the `rollout status` reports "successfully rolled out" after both the image change and the undo, your rolling-deploy strategy works.

To verify the cloud-run variant without deploying, validate the YAML:

```bash
gcloud run services replace --dry-run cloud-run.service.yaml
# Expect: the YAML is parsed and validated; no errors.
```

## Previously Learned Here

These concepts were taught in earlier lessons. We link back instead of re-explaining:

- **The Docker image** — [[16-Deployment-and-DevOps/Docker-Multi-Stage-Non-Root]]. The new detail is the image is the same across all three targets in this lesson. The contract between developer and operator is the image; everything else is configuration.
- **Pydantic Settings** — [[04-Pydantic/Pydantic-Settings]]. The env vars every target injects (`APP_DATABASE_URL`, `APP_REDIS_URL`, `APP_ENV`) are read by the `Settings` class. The target's job is to inject the env vars; the container's job is to read them.
- **FastAPI lifespan** — [[03-FastAPI-Core/Application-and-Lifespan]]. The `/healthz` and `/readyz` endpoints that every target's probes hit are defined in the lifespan. The readiness/liveness distinction maps directly onto the target's two-probe pattern.
- **Migration ordering** — [[16-Deployment-and-DevOps/Migration-Ordering-and-Rollback]]. The `scripts/deploy_migrations.py` one-shot container runs the same way on all three targets — as a sidecar container on the VM, as a `Job` on Kubernetes, or as a Cloud Run Job. The expand-contract pattern is what makes rolling deploys safe.
- **Container hygiene** — the non-root user, the `tini` PID 1, the exec-form `CMD` — are enforced in the image, not in the target. Every target inherits them for free.

## What's Next

The portfolio projects in [[18-Portfolio-Projects/00-Projects-MOC]] exercise every target in this lesson:

- [[18-Portfolio-Projects/01-ForgeTrack-Manufacturing-Operations]] is shipped on a single VM with `docker compose`. (Variant A.) The starter's `compose.prod.yml` is the manifest.
- [[18-Portfolio-Projects/02-Multi-Tenant-Billing-SaaS]] is shipped on Fly.io. (Managed platform.) The starter's `fly.toml` is the manifest.
- [[18-Portfolio-Projects/06-RealTime-Collaboration-Notifications]] is shipped on Kubernetes because of the long-lived-connection requirement. (Variant B.) The starter's `k8s/` directory is the manifest set.
- [[18-Portfolio-Projects/07-AI-Augmented-Support-Backend]] is shipped on Kubernetes for the same reason as Project 06 (long-lived SSE connections) plus the multi-deployable requirement (API + embedding worker + CRM worker scale independently with different profiles). The starter's deployment guide reuses Project 06's reverse-proxy / Cloudflare SSE config.

No project in the vault is shipped on serverless (Cloud Run). That is deliberate — the long-lived-connection and steady-traffic workloads in the portfolio do not match serverless' strengths. The one workload that *would* match (a spiky webhook receiver) is left as an exercise.

If you want to deepen this lesson specifically, read the canonical sources below (the Kubernetes Documentation, the Cloud Run documentation, the Fly.io documentation) and the Argo CD documentation for GitOps.

### Forward references (taught later, but visible from here)

These concepts show up in this lesson's reading — but they are formally taught in other sections. Skim now for shape; the canonical lessons will re-teach them:

- **Observability** — [[13-Performance-and-Observability/Structured-Logging-and-Request-IDs]] and [[13-Performance-and-Observability/OpenTelemetry-Tracing]]. Canary deploys are predicated on per-version observability; the OpenTelemetry spans carry the version tag.
- **Production incidents** — [[19-Interview-Preparation/Production-Incidents-Debugging]]. Incident 6 (pool exhaustion) is a deployment-target incident — a bad `replicas` count caused connection-pool exhaustion. The target choice and the connection-pool size are coupled.
- **Deployment topology** — [[22-Diagrams/Deployment-Topology]]. The canonical production topology diagram shows where the cluster, the load balancer, and the database sit; this lesson's three variants map onto that diagram.

## Sources

- **Kubernetes — Documentation** — <https://kubernetes.io/docs/> — accessed 2026-10-19 — the canonical reference for `Deployment`, `Service`, `Ingress`, `readinessProbe`, `livenessProbe`, `HorizontalPodAutoscaler`. The vocabulary in this lesson is the vocabulary in this documentation.
- **Google Cloud Run — Documentation** — <https://cloud.google.com/run/docs> — accessed 2026-10-19 — the canonical reference for Cloud Run's `Service` primitive, the `containerConcurrency` knob, the `autoscaling.knative.dev/minScale` annotation, and the request-timeout cap.
- **Fly.io — Documentation** — <https://fly.io/docs/> — accessed 2026-10-19 — the canonical reference for the managed-app-platform middle ground. The `fly.toml` format is the manifest equivalent of `compose.prod.yml`.
- **Argo CD — Documentation** — <https://argo-cd.readthedocs.io/> — accessed 2026-10-19 — the canonical GitOps reconciler for Kubernetes. The pull-based deploy model in this lesson is what Argo CD implements.
- **Flux — Documentation** — <https://fluxcd.io/> — accessed 2026-10-19 — the alternative GitOps reconciler; lighter-weight than Argo CD for small clusters.
- **kind — Kubernetes in Docker** — <https://kind.sigs.k8s.io/> — accessed 2026-10-19 — the local Kubernetes cluster used in this lesson's exercises.
- **Martin Fowler — "CanaryRelease"** — <https://martinfowler.com/bliki/CanaryRelease.html> — accessed 2026-10-19 — the canonical essay on the canary strategy and the observability prerequisite.
- **Brandur — "Distributed deploys" essays** — <https://brandur.org/> — accessed 2026-10-19 — practical essays on blue-green, canary, and rolling deploys from a production engineer's perspective.
- **Honeycomb — "Canary deployments and observability"** — <https://www.honeycomb.io/blog/canary-deployments-and-observability> — accessed 2026-10-19 — the argument that canary without observability is theatre, made concrete.
- **Cloud Run Pricing** — <https://cloud.google.com/run/pricing> — accessed 2026-10-19 — verified October 2026 pricing for the worked example in the Line-by-Line Deep Dive.
- **AWS EC2 Pricing** — <https://aws.amazon.com/ec2/pricing/> — accessed 2026-10-19 — verified October 2026 pricing for the VM comparison.
- See [[21-Reference-Library/Source-Register]] for the full source list with dates accessed.

## What We Learned

Let's recap. In this lesson you:

- **Named the five-target spectrum** — VM, Docker on a VM, Kubernetes, serverless / FaaS, managed app platform — and the property that distinguishes each from the next.
- **Deployed the same `Boardly` Docker image three ways** — on a VM with `docker compose -f compose.prod.yml`, on Kubernetes with a `Deployment` + `Service` + `Ingress`, on Google Cloud Run with a `Service` manifest. The image did not change; the manifests did.
- **Chose between blue-green, canary, and rolling deploys** based on the workload's tolerance for in-flight version mixing and the team's tolerance for infrastructure cost. The default is rolling; blue-green for risky code; canary only with observability.
- **Chose between GitOps and push-based CI/CD** based on team size and audit requirements. The default for small teams is push-based; the upgrade path to GitOps is gradual (add Argo CD as a watcher, then remove CI's `kubectl` credentials).
- **Quantified when serverless stops being cheaper** — the break-even is roughly 5–10 req/s steady-state. Below that, serverless wins on cost. Above that, VM or Kubernetes wins.
- **Identified when Kubernetes overpays for itself** — below 5 services, below 5 engineers, no multi-region requirement. The 2026 default is a managed app platform; Kubernetes is the upgrade.
- **Diagnosed the failure modes of each target** — VM single-points-of-failure, Kubernetes operational complexity, serverless cold-start latency and connection limits, managed platform's compliance gaps.
- **Recognised the seven classic deployment-target mistakes** — serverless for long-lived connections, Kubernetes for one service, blue-green for risky migrations, canary without observability, GitOps without drift detection, VMs without autoscaling, managed platform for compliance workloads.

Here's the mental model to walk away with: *the deployment target is a property of the workload, not a property of the team's preferences. Match the target's cost shape and operational profile to the workload's traffic pattern and connection profile. The 2026 default is the managed app platform — the cheapest target that survives the next 12 months of growth. Kubernetes, serverless, and bare VMs are right for specific workloads, not for default workloads.*

---

> A note from your teacher
You just deployed the same image three ways. The lesson is not "Kubernetes is best" or "serverless is best" — it is that the three targets are *the same application* with *different operational profiles*. The image did not change. The manifests described how the platform should run it. The platform did the work. The next time someone tells you "we should be on Kubernetes," ask them which workload, which team, and which multi-region requirement. If they cannot answer, you have your answer. The platform is the variable; the application is the constant. See you in the portfolio projects.


---

**Tags:** #deployment #kubernetes #serverless #vm #comparison #review
**Previous:** [[16-Deployment-and-DevOps/Migration-Ordering-and-Rollback]]
**Next:** [[17-Advanced-Architecture/00-Advanced-Architecture-MOC]] →
