(() => {
  const guide = document.createElement('dialog');
  guide.className = 'crm-import-guide';
  guide.setAttribute('aria-labelledby', 'crm-guide-title');
  guide.innerHTML = `
    <header>
      <h2 id="crm-guide-title">Guía de importación CRM</h2>
      <button type="button" autofocus>Cerrar</button>
    </header>
    <div class="crm-guide-body" tabindex="0" role="region" aria-label="Pasos de importación">
      <ol>
        <li><h3>Configura tu fuente CRM</h3>
          <p>Introduce la URL de exportación que te proporciona tu CRM. Normalmente solo tendrás que configurarla una vez. Si no sabes cuál es, solicítala a tu proveedor de CRM.</p></li>
        <li><h3>Simula la importación</h3>
          <p>Pulsa «Simular importación» («Simular sincronización» en tu perfil) para comprobar qué inmuebles encuentra HomeClick24.</p>
          <p class="crm-guide-notice"><strong>Simular no publica, modifica ni elimina ningún inmueble.</strong></p></li>
        <li><h3>Revisa los inmuebles encontrados</h3>
          <p>HomeClick24 te mostrará los inmuebles disponibles para importar. Comprueba si alguno ya está publicado en HomeClick24 para evitar duplicados.</p></li>
        <li><h3>Selecciona los inmuebles</h3>
          <p>Marca los inmuebles que quieras importar, hasta <strong>10 inmuebles en cada operación</strong>.</p>
          <p>No necesitas contar las fotografías. HomeClick24 aplicará automáticamente los límites de tu plan a cada anuncio.</p></li>
        <li><h3>Importa</h3>
          <p>Pulsa «Importar seleccionados» y confirma la operación. Si hay muchas fotografías, puede tardar varios minutos.</p>
          <p class="crm-guide-notice"><strong>No vuelvas a iniciar la misma importación mientras aparezca como procesándose.</strong></p></li>
        <li><h3>Consulta el estado</h3>
          <dl>
            <dt>Procesando</dt><dd>HomeClick24 sigue trabajando.</dd>
            <dt>Completada</dt><dd>Los inmuebles se han importado.</dd>
            <dt>Completada con algún error</dt><dd>Algunos inmuebles se han importado y otros necesitan revisión.</dd>
            <dt>Error</dt><dd>La importación no pudo completarse para uno o varios inmuebles.</dd>
            <dt>Resultado pendiente de confirmación</dt><dd>Consulta el estado antes de volver a intentarlo.</dd>
          </dl></li>
        <li><h3>Después de importar</h3>
          <p>Los inmuebles importados quedan vinculados a tu CRM. Así HomeClick24 puede reconocerlos en futuras simulaciones y evitar volver a tratarlos como nuevos.</p></li>
      </ol>
      <aside aria-labelledby="crm-guide-important">
        <h3 id="crm-guide-important">Importante</h3>
        <ul>
          <li>Simular no publica nada.</li>
          <li>No repitas una importación que siga procesándose.</li>
          <li>Si tienes dudas de que un inmueble ya exista en HomeClick24, revísalo antes de marcarlo.</li>
        </ul>
      </aside>
    </div>`;
  document.body.append(guide);
  guide.querySelector('button').addEventListener('click', () => guide.close());
  for (const button of document.querySelectorAll('[data-crm-guide]')) {
    button.addEventListener('click', () => {
      guide.showModal();
      guide.querySelector('.crm-guide-body').scrollTop = 0;
    });
  }
})();
