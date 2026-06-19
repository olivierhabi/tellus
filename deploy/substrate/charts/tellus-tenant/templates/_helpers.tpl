{{- define "tellus-tenant.namespace" -}}
{{- printf "tenant-%s" .Values.tenant | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "tellus-tenant.fullname" -}}
{{- printf "tellus-%s" .Values.tenant | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "tellus-tenant.labels" -}}
app.kubernetes.io/name: tellus
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: helm
tellus.io/tenant: {{ .Values.tenant | quote }}
{{- end -}}

{{- define "tellus-tenant.selectorLabels" -}}
app.kubernetes.io/name: tellus
tellus.io/tenant: {{ .Values.tenant | quote }}
{{- end -}}
