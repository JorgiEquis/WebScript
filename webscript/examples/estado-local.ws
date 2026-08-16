style boton =
    -> background-color: blue
    -> color: white
    -> border: none

visual contadorLocal =
    reactive contador = 0
<button class={boton} onclick={contador++}>
    Clicks: {contador}
</button>

visual app =
<div>
    <contadorLocal />
    <contadorLocal />
</div>

render(
    app
)
