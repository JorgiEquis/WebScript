reactive contador = 0

style boton =
    -> background-color: blue
    -> color: white
    -> border: none

style tarjeta =
    -> padding: 16px
    -> border: 1px solid #cccccc
    -> border-radius: 8px

visual contadorBtn =
<button class={boton} onclick={contador++}>
    Clicks: {contador}
</button>

visual panelTarjeta =
<div class={tarjeta}>
    <h3>{props.titulo}</h3>
    <slot />
</div>

visual app =
<panelTarjeta titulo="Panel de control">
    <contadorBtn />
</panelTarjeta>

render(
    app
)
