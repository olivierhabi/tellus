{{- define "tellus-tenant.namespace" -}}
{{- if .Values.namespaceOverride -}}
{{- .Values.namespaceOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "tenant-%s" .Values.tenant | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "tellus-tenant.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "tellus-%s" .Values.tenant | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "tellus-tenant.labels" -}}
app.kubernetes.io/name: tellus
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/component: api
tellus.io/tenant: {{ .Values.tenant | quote }}
{{- end -}}

{{- define "tellus-tenant.selectorLabels" -}}
app.kubernetes.io/name: tellus
app.kubernetes.io/instance: {{ .Release.Name }}
tellus.io/tenant: {{ .Values.tenant | quote }}
{{- end -}}

{{- define "tellus-tenant.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "tellus-tenant.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}
