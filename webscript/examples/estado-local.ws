style boton =
    -> background-color: blue
    -> color: white
    -> border: none

visual contadorLocal =
    reactive contador = 0
<button>
    Clicks: {contador}
</button>
    -> style: boton
    -> onclick:
        contador++

visual app =
<div>
    <contadorLocal />
    <contadorLocal />
</div>

render(
    app
)
