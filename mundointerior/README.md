# Mundo Interior · Forja Estelar

Universo 3D de paneles de contenido (Three.js r128 + CSS3D) con la Forja Estelar:
Kairós de plasma (textos, voces y videos en órbita), soles de audio, Radio Tagua Tagua y radar.

## Archivos
- `index.html` — Mundo Interior (con 7 puntos de enganche marcados `// FORJA`)
- `forja_soles.js` — soles de audio y nebulosa de Radio Tagua Tagua
- `forja_kairos.js` — estrellas Kairós, satélites, almacén IndexedDB, grabadora y fotogramas
- `forja_estelar.js` — paneles, órbita (C), zoom (Enter), radar, controles táctiles

Los tres `.js` deben cargarse en ese orden, después del script principal.

## Teclas
`C` orbitar · `Shift+C` / `Esc` salir · `Enter` zoom al video más cercano · `Espacio` pausa en zoom ·
`W/S` acercarse en órbita · `A/D/Q/E` girar · `Z/X` subir/bajar

Arrastrar un texto o video de un Kairós cambia su órbita (mouse o dedo). `Shift` + arrastrar un Kairós, un sol o una radio lo mueve.
Soles y radios suenan según la distancia a su núcleo y dejan de transmitir fuera de su influjo; retoman al volver.

El micrófono requiere HTTPS (GitHub Pages) o localhost. Los audios y videos se guardan en el IndexedDB del navegador.
