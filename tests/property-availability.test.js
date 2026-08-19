import test from "node:test";
import assert from "node:assert/strict";
import {
  filtroEstadoDisponibleMongo,
  propiedadDisponiblePublicamente,
  tieneEstadoNoDisponible,
  tieneOcultacionManualSeparada
} from "../utils/propertyAvailability.js";

test("propiedadDisponiblePublicamente excluye ocultas, eliminadas e inactivas", () => {
  assert.equal(propiedadDisponiblePublicamente({ visiblePublicamente: true }), true);
  assert.equal(propiedadDisponiblePublicamente({ visiblePublicamente: false }), false);
  assert.equal(propiedadDisponiblePublicamente({ activo: false }), false);
  assert.equal(propiedadDisponiblePublicamente({ eliminada: true }), false);
  assert.equal(propiedadDisponiblePublicamente({ ocultaManual: true }), false);
  assert.equal(tieneOcultacionManualSeparada({ ocultoPorAdmin: true }), true);
});

test("propiedadDisponiblePublicamente excluye estados comerciales no disponibles", () => {
  assert.equal(tieneEstadoNoDisponible({ estadoComercial: "Disponible" }), false);
  assert.equal(propiedadDisponiblePublicamente({ estadoComercial: "Reservado" }), false);
  assert.equal(propiedadDisponiblePublicamente({ estadoComercial: "Vendido" }), false);
  assert.equal(propiedadDisponiblePublicamente({ estadoComercial: "Alquilado" }), false);
  assert.equal(propiedadDisponiblePublicamente({ estadoComercial: "No disponible" }), false);
});

test("filtroEstadoDisponibleMongo descarta estados y marcas no publicables", () => {
  const filtro = filtroEstadoDisponibleMongo();

  assert.deepEqual(filtro.activo, { $ne: false });
  assert.deepEqual(filtro.eliminada, { $ne: true });
  assert.deepEqual(filtro.oculta, { $ne: true });
  assert.ok(filtro.estadoComercial.$nin.includes("Reservado"));
  assert.ok(filtro.estadoComercial.$nin.includes("Vendido"));
  assert.ok(filtro.estadoComercial.$nin.includes("Alquilado"));
  assert.ok(filtro.estadoComercial.$nin.includes("No disponible"));
});
