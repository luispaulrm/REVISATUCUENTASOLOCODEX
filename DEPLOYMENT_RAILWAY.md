# 🚀 GUÍA DE DEPLOYMENT - OpenAI + Gemini en Railway

## ✅ Pre-requisitos

1. **API Keys obtenidas:**
   - ✅ OpenAI: https://platform.openai.com/api-keys (formato: `sk-...`)
   - ✅ Gemini: https://aistudio.google.com/app/apikey

2. **Repositorio Git** (GitHub, GitLab, etc.)

3. **Cuenta en Railway.app**

---

## 🔧 PASO 1: Configurar Variables en Railway

### Via Railway Dashboard:

1. Ve a tu proyecto en Railway
2. Haz clic en **Settings** → **Environment**
3. Agrega estas variables:

```
GEMINI_API_KEY = AIzaSy...
OPENAI_API_KEY = sk-proj-...
PORT = 5000
NODE_ENV = production
```

**Opcional (para más capacidad):**
```
GEMINI_API_KEY_SECONDARY = AIzaSy...
GEMINI_API_KEY_TERTIARY = AIzaSy...
OPENAI_API_KEY_SECONDARY = sk-proj-...
```

### O via Railway CLI:

```bash
# Login
railway login

# Link proyecto
railway link

# Set variable
railway variables set OPENAI_API_KEY=sk-proj-...
railway variables set GEMINI_API_KEY=AIzaSy...
```

---

## 📝 PASO 2: Configurar railway.yaml

En la raíz del proyecto, crea/actualiza `railway.yaml`:

```yaml
services:
  api:
    build:
      builder: nixpacks
      nixpacksConfig:
        pkgFlake: |
          {
            inputs = {
              nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
              flake-utils.url = "github:numtide/flake-utils";
            };
            outputs = { self, nixpkgs, flake-utils }:
              flake-utils.lib.eachDefaultSystem (system:
                let
                  pkgs = nixpkgs.legacyPackages.${system};
                in
                {
                  devShells.default = pkgs.mkShell {
                    buildInputs = with pkgs; [
                      nodejs_20
                    ];
                  };
                }
              );
          }
    start: npm run start
    healthcheck:
      test: curl --fail http://localhost:$PORT/ || exit 1
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  node_modules:
    mount: /app/node_modules
```

---

## 🔄 PASO 3: Deploy

### Opción A: Git Push (Recomendado)

Railway detecta automáticamente cambios en tu repo:

```bash
git add .
git commit -m "Fix: OpenAI API integration with proper tokens and vision support"
git push origin main
# Railway despliega automáticamente
```

### Opción B: Manual Redeploy

```bash
railway deploy --service api
```

---

## ✅ PASO 4: Verificar Deployment

### En Railway Dashboard:

1. Ve a **Deployments**
2. Busca el build más reciente
3. Haz clic para ver los logs

### Logs esperados (✅ CORRECTO):

```
[ENV_CHECK] GEMINI KEY PRESENT: true
[ENV_CHECK] OPENAI_API_KEY LOADED: sk-proj-...
✅ Server running on port 5000
✅ GeminiService initialized
✅ OpenAI Service initialized
```

### Logs de ERROR (❌ REVISAR):

```
❌ GEMINI_API_KEY NOT FOUND        → Configurar en Railway
❌ OPENAI_API_KEY not found        → Configurar en Railway
ERROR: max_completion_tokens: 35000 → Revisar versión (debe estar 8000)
```

---

## 🧪 PASO 5: Test Final

### Desde tu máquina local:

```bash
# 1. Verificar config
npm run check-config

# 2. Test de APIs (si está disponible)
npm run test:apis

# 3. Prueba manual
curl -X POST https://tu-app.railway.app/api/audit/pre-check \
  -H "Content-Type: application/json" \
  -d '{
    "cuentaJson": {"items": []},
    "pamJson": {"folios": []},
    "contratoJson": {"rules": []}
  }'
```

### Respuesta esperada (✅):
```json
{
  "status": "ok",
  "capabilities": {
    "openai": true,
    "gemini": true
  }
}
```

---

## 🛡️ TROUBLESHOOTING

### Problema: Error 400 en M11

**Causa:** `max_completion_tokens` demasiado alto

**Solución:**
```bash
# Verificar en server/config/ai.config.ts
maxOutputTokens: 8000  ✅ (NO 35000)

# Redeploy
git push origin main
```

### Problema: 429 Rate Limit

**Causa:** Cuota de OpenAI/Gemini excedida

**Solución:**
1. Revisar https://platform.openai.com/account/usage
2. Subir límites de uso (Account → Usage Limits)
3. Agregar tarjeta de crédito si es necesario
4. Esperar 24 horas para reset

### Problema: 401 Unauthorized

**Causa:** API key inválida o expirada

**Solución:**
```bash
# 1. Generar nueva key
# OpenAI: https://platform.openai.com/api-keys
# Gemini: https://aistudio.google.com/app/apikey

# 2. Actualizar en Railway
railway variables set OPENAI_API_KEY=sk-proj-nuevo...

# 3. Redeploy
railway deploy --service api
```

### Problema: Timeout en auditoría

**Causa:** Imagen muy grande o procesamiento lento

**Solución:**
```typescript
// En server.ts, aumentar timeout a 300s:
const timeoutMs = 300000;  // 5 minutos
```

---

## 📊 MONITOREO

### Métricas en Railway:

1. **CPU:** Debe estar < 50% en reposo
2. **Memoria:** < 300MB en reposo
3. **Request Rate:** Depende de carga

### Logs a monitorear:

```bash
# Ver logs en vivo
railway logs --service api --tail

# Filtrar errores
railway logs --service api --tail | grep "❌\|ERROR"
```

---

## 🔄 ROLLBACK de Emergencia

Si el nuevo deployment falla:

```bash
# Via Railway CLI
railway rollback

# O en Dashboard: Deployments → Seleccionar versión anterior
```

---

## 📝 CHECKLIST PRE-DEPLOY

Antes de hacer push a producción:

- [ ] `npm run check-config` muestra ✅
- [ ] `npm run test:apis` funciona (local)
- [ ] `maxOutputTokens: 8000` en `ai.config.ts`
- [ ] `OPENAI_API_KEY` configurada en Railway
- [ ] `GEMINI_API_KEY` configurada en Railway
- [ ] No hay errores en `npm run build`
- [ ] Prueba local con `npm run dev:all`
- [ ] M11 puede ejecutar auditoría de prueba

---

## 📞 SOPORTE

**Si hay problemas después de deploy:**

1. Revisar logs: `railway logs --tail`
2. Verificar variables: `railway variables`
3. Redeploy: `railway deploy --service api`
4. Rollback si es necesario: `railway rollback`

**Contacto:**
- OpenAI Status: https://status.openai.com
- Gemini Issues: https://issuetracker.google.com
- Railway Support: https://docs.railway.app
