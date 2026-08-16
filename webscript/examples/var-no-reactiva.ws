reactive precioBase = 100
var iva = precioBase * 0.21

style boton =
    -> background-color: teal
    -> color: white

visual panel =
<div>
    <p>Precio base: {precioBase}</p>
    <p>IVA (calculado una vez): {iva}</p>
</div>

visual subirPrecio =
<button class={boton} onclick={precioBase = precioBase + 10}>
    Subir precio +10
</button>

render(
    panel,
    subirPrecio
)
