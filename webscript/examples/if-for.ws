reactive contador = 0
reactive lista = ["manzana", "pera", "uva"]

style boton =
    -> background-color: blue
    -> color: white
    -> border: none

visual estado =
<div>
    if (contador == 0)
        <p>Aun no hay clicks</p>
    else if (contador < 3)
        <p>Vas por buen camino</p>
    else
        <p>Ya son muchos clicks</p>
</div>

visual listaFrutas =
<ul>
    for (fruta in lista)
        <li>{fruta}</li>
</ul>

visual boton =
<button>
    Clicks: {contador}
</button>
    -> style: boton
    -> onclick:
        contador++

render(
    estado,
    boton,
    listaFrutas
)
