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
<button>
    Clicks: {contador}
</button>
    -> style: boton
    -> onclick:
        contador++

visual panelTarjeta =
<div>
    <h3>{props.titulo}</h3>
    <slot />
</div>
    -> style: tarjeta

visual app =
<panelTarjeta titulo="Panel de control">
    <contadorBtn />
</panelTarjeta>

render(
    app
)
