# ⚡ GUÍA RÁPIDA - OpenAI Integration

## 🚀 INICIO RÁPIDO (5 minutos)

### 1. Obtener API Keys
```
🔑 OpenAI:    https://platform.openai.com/api-keys (sk-...)
🔑 Gemini:    https://aistudio.google.com/app/apikey
```

### 2. Configurar .env
```bash
cd server
cp env.example .env
# Editar .env y agregar:
# OPENAI_API_KEY=sk-proj-...
# GEMINI_API_KEY=AIzaSy...
```

### 3. Verificar Setup
```bash
npm run check-config
# Salida esperada: ✅ Configuración lista!
```

### 4. Iniciar
```bash
npm run dev:all
# Debería mostrar: GeminiService initialized, OpenAI Service initialized
```

### 5. ¡Listo! 🎉
Ambas APIs están activas y el sistema usa automáticamente la correcta según el modelo.

---

## 📌 COMANDOS ÚTILES

| Comando | Función |
|---------|---------|
| `npm run check-config` | Verifica que las API keys estén configuradas |
| `npm run test:apis` | Prueba conectividad con ambas APIs |
| `npm run dev:all` | Inicia frontend + backend |
| `npm run server` | Solo backend (development) |
| `npm run start` | Solo backend (production) |

---

## 🎯 USO EN M11

```
1. Abrir M11 (Auditor M11 v2.0)
2. Cargar: Contrato + PAM + Cuenta
3. Ejecutar Auditoría
   → Automáticamente usa GPT-4o (mejor para análisis)
   → Si falla, intenta Gemini
4. ✅ Resultado: Análisis forense completo
```

---

## ⚠️ ERRORES COMUNES

| Error | Solución |
|-------|----------|
| `❌ OPENAI_API_KEY NOT FOUND` | Agregar en .env: `OPENAI_API_KEY=sk-...` |
| `❌ Error 400 in OpenAI` | Revisar que `maxOutputTokens: 8000` en ai.config.ts |
| `❌ 429 Rate Limit` | Esperar 1 minuto, reintentar |
| `❌ Timeout` | La respuesta tardó >180s, aumentar a 300s si es necesario |
| `❌ 401 Unauthorized` | API key expirada, generar nueva en OpenAI |

---

## 📊 VARIABLES DE AMBIENTE

```bash
# REQUERIDAS
GEMINI_API_KEY=AIzaSy...
OPENAI_API_KEY=sk-proj-...

# OPCIONALES (para redundancia)
GEMINI_API_KEY_SECONDARY=AIzaSy...
GEMINI_API_KEY_TERTIARY=AIzaSy...

# SERVIDOR
PORT=5000
NODE_ENV=development  # o production
```

---

## 🔍 VALIDAR SETUP

```bash
# Paso 1: Verificar config
$ npm run check-config
✅ OPENAI_API_KEY válida (sk-proj-...)
✅ GEMINI_API_KEY válida (AIzaSy...)
✅ Configuración lista!

# Paso 2: Test APIs
$ npm run test:apis
✅ OpenAI Service: FUNCIONAL
✅ Gemini Service: FUNCIONAL

# Paso 3: Iniciar servidor
$ npm run dev:all
✅ GeminiService initialized
✅ OpenAI Service initialized
✅ Server running on port 5000
```

Si todo muestra ✅, ¡estás listo!

---

## 📱 DEPLOYMENT EN RAILWAY

```bash
# 1. Agregar variables en Railway Dashboard
Settings → Environment → Agregar:
  GEMINI_API_KEY = AIzaSy...
  OPENAI_API_KEY = sk-proj-...

# 2. Push a Git (Railway deploya automáticamente)
git add .
git commit -m "OpenAI integration fixed"
git push origin main

# 3. Verificar deploy
railway logs --tail
# Buscar: ✅ Server running on port 5000
```

---

## 🎓 ARQUITECTURA

```
┌─────────────────────────────────────────┐
│          Usuario (M11 App)              │
└────────────────┬────────────────────────┘
                 │
        ┌────────▼────────┐
        │  server.ts      │
        │  (Express)      │
        └────────┬────────┘
                 │
        ┌────────▼──────────────────┐
        │  GeminiService            │
        │  (Coordinador)            │
        ├───────────┬───────────────┤
        │           │               │
   ┌────▼───┐  ┌───▼────┐   ┌─────▼────┐
   │ Gemini │  │ OpenAI │   │ Fallback │
   │  API   │  │  API   │   │ Logic    │
   └────────┘  └────────┘   └──────────┘
```

---

## 💡 TIPS

- **🔒 Seguridad:** Nunca comitear .env a Git, usar .gitignore
- **💰 Costo:** Gemini es más barato ($0.1 vs $2.5 por 1M tokens)
- **⚡ Velocidad:** OpenAI es más rápido (2-3s vs 3-5s)
- **👁️ Visión:** GPT-4o es mejor para OCR en facturas complejas
- **🔄 Failover:** Si una API cae, la otra toma automáticamente

---

## 🆘 SOPORTE

Si tienes problemas:

1. **Verificar logs:**
   ```bash
   # Local
   npm run dev:all 2>&1 | grep ERROR

   # Railway
   railway logs --tail | grep ERROR
   ```

2. **Revisar configuración:**
   ```bash
   npm run check-config
   ```

3. **Test de conectividad:**
   ```bash
   npm run test:apis
   ```

4. **Revisar documentación:**
   - `OPENAI_FIXES_REFERENCE.md` - Detalles técnicos
   - `DEPLOYMENT_RAILWAY.md` - Deploy en producción
   - `SOLUCION_OPENAI_COMPLETADA.md` - Resumen completo

---

**🎉 ¡Listo! Disfruta de tu sistema de auditoría potenciado por IA**

*v1.5.0 - OpenAI Integration Complete*
