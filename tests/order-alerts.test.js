import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const alertsSource = readFileSync(new URL("../public/js/services/order-alerts.js", import.meta.url), "utf8");
const audioManagerSource = readFileSync(new URL("../public/js/services/audio-alert-manager.js", import.meta.url), "utf8");
const routesSource = readFileSync(new URL("../server/modules/order-alerts/order-alerts.routes.js", import.meta.url), "utf8");
const pedidoRoutesSource = readFileSync(new URL("../server/modules/pedidos/pedidos.routes.js", import.meta.url), "utf8");
const eventsSource = readFileSync(new URL("../server/services/order-alerts/order-alerts.events.js", import.meta.url), "utf8");
const schemaSource = readFileSync(new URL("../server/schema.sql", import.meta.url), "utf8");

test("new pending order alert is global and independent from release tab", () => {
  assert.match(appSource, /startOrderAlerts\(/);
  assert.match(alertsSource, /new EventSource\("\/api\/admin\/order-alert-events"\)/);
  assert.match(alertsSource, /state\.currentView === "release"/);
  assert.match(alertsSource, /\/api\/admin\/order-alert-summary/);
});

test("order alerts are restricted to warehouse users and have preferences", () => {
  assert.match(routesSource, /user\.role !== "admin"/);
  assert.match(routesSource, /\/api\/user\/order-alert-preferences/);
  assert.match(routesSource, /user_order_alert_preferences/);
  assert.match(routesSource, /order_alert_sounds/);
  assert.match(schemaSource, /CREATE TABLE IF NOT EXISTS user_order_alert_preferences/);
  assert.match(schemaSource, /CREATE TABLE IF NOT EXISTS order_alert_sounds/);
});

test("order creation publishes one event only for fresh idempotent creation", () => {
  // NEW_PENDING_ORDER (com alarme) fica reservado ao pedido que abre um card novo. Quando o
  // envio entra num pedido que ja existe (juncao dentro da janela), sai ORDER_ITEMS_UPDATED,
  // que atualiza a tela sem repetir o alarme -- o card ja esta la.
  assert.match(pedidoRoutesSource, /\? "ORDER_ITEMS_UPDATED" : "NEW_PENDING_ORDER"/);
  // A garantia original: reenvio idempotente do MESMO clique nao publica evento nenhum
  assert.match(pedidoRoutesSource, /if \(!result\.repeated && result\.alert\)/);
  assert.match(eventsSource, /eventId/);
  assert.match(eventsSource, /clients = new Set/);
});

test("frontend avoids duplicate sounds across refreshes and multiple tabs", () => {
  assert.match(alertsSource, /rememberListValue\(storageKey/);
  assert.match(alertsSource, /BroadcastChannel\(channelName\)/);
  assert.match(alertsSource, /localStorage\.setItem\(key/);
  assert.match(audioManagerSource, /activationKey/);
  assert.match(audioManagerSource, /activeOrderIds/);
});

test("order alerts support repetitive sounds and silent stop actions", () => {
  assert.match(audioManagerSource, /repeatModeConfig/);
  assert.match(audioManagerSource, /three_times/);
  assert.match(audioManagerSource, /until_viewed/);
  assert.match(audioManagerSource, /until_service_start/);
  assert.match(alertsSource, /Silenciar alerta/);
  assert.match(alertsSource, /stopOnView/);
  assert.match(alertsSource, /stopOnServiceStart/);
});

test("blocked audio alerts remain queued until browser audio is activated", () => {
  assert.match(audioManagerSource, /playUnlockPulse/);
  assert.match(audioManagerSource, /audioUnlocked/);
  assert.match(audioManagerSource, /pauseUntilAudioActivation/);
  assert.match(audioManagerSource, /alertState\.queue\.unshift\(next\)/);
  assert.match(audioManagerSource, /drainQueue\(\)/);
  assert.match(alertsSource, /requeueActiveAudioAlerts/);
});

test("viewing one alert releases audio manager for future orders", () => {
  assert.match(audioManagerSource, /timerResolve/);
  assert.match(audioManagerSource, /function clearAlertTimer/);
  assert.match(audioManagerSource, /resolve\?\.\(\)/);
  assert.match(audioManagerSource, /if \(orderId\) \{/);
  assert.match(audioManagerSource, /alertState\.queue = alertState\.queue\.filter\(\(item\) => item\.orderId !== orderId\)/);
  assert.match(alertsSource, /markAlertStopped\(orderId, eventId, "VIEWED"\)/);
  assert.doesNotMatch(alertsSource, /preferences\.enabled\s*=\s*false/);
});

test("enabled sound preference keeps browser audio authorization active", () => {
  assert.match(audioManagerSource, /audioUnlocked: localStorage\.getItem\(activationKey\) === "true"/);
  assert.match(audioManagerSource, /return localStorage\.getItem\(activationKey\) === "true"/);
  assert.match(audioManagerSource, /localStorage\.setItem\(activationKey, "true"\)/);
  assert.doesNotMatch(audioManagerSource, /localStorage\.removeItem\(activationKey\)/);
  assert.match(alertsSource, /enabled\?\.addEventListener\("change"/);
  assert.match(alertsSource, /if \(enabled\.checked\) await activateOrderAlertAudio\(\)/);
  assert.match(alertsSource, /if \(payload\.enabled\) await activateOrderAlertAudio\(\)/);
});

test("new order visual alert stays fixed until viewed or silenced", () => {
  assert.match(alertsSource, /activeAlerts = new Map/);
  assert.match(alertsSource, /acparkViewedOrderAlerts/);
  assert.match(alertsSource, /acparkSilencedOrderAlerts/);
  assert.match(alertsSource, /ORDER_ALERT_STOPPED/);
  assert.doesNotMatch(alertsSource, /setTimeout\(\(\) => node\.remove/);
});

test("warehouse devices rebuild visual alerts from current pending orders", () => {
  assert.match(alertsSource, /function showPendingSnapshotAlerts/);
  assert.match(alertsSource, /showPendingSnapshotAlerts\(snapshot\)/);
  assert.match(alertsSource, /eventId = order\.eventId \|\| `pending:\$\{orderId\}`/);
  assert.match(alertsSource, /showOrderToast\(\{ \.\.\.order, eventId \}\)/);
});

test("viewing an order alert focuses the release order card", () => {
  assert.match(alertsSource, /acparkFocusReleaseOrder/);
  assert.match(appSource, /focusReleaseOrderFromAlert/);
  assert.match(appSource, /order-alert-focus/);
});

test("viewing an order alert does not apply order code as a release filter", () => {
  assert.doesNotMatch(appSource, /searchCode\s*=\s*focusOrderCode/);
  assert.match(appSource, /Visualizar todos os pendentes/);
  assert.match(appSource, /Manter filtros/);
  assert.match(appSource, /focusRetry/);
});

test("order alert preferences persist repeat configuration", () => {
  assert.match(routesSource, /repeat_mode/);
  assert.match(routesSource, /repeat_interval_seconds/);
  assert.match(routesSource, /stop_on_view/);
  assert.match(routesSource, /stop_on_service_start/);
  assert.match(schemaSource, /repeat_mode/);
  assert.match(schemaSource, /repetitive-alert/);
  assert.match(schemaSource, /soft-continuous/);
});
