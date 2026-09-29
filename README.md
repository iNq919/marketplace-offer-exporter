# Allegro + Ceneo + OLX Offer Exporter v1.9.0

Rozszerzenie Chrome zbiera oferty z Allegro, produkty z Ceneo i ogłoszenia z OLX oraz przygotowuje eksport TXT/JSON i fragmenty do wklejenia do ChatGPT.

## Najważniejsze zmiany v1.9.0

- Każdy serwis ma osobny, widoczny limit workerów bezpośrednio na swojej karcie.
- Domyślne limity: Allegro 1, Ceneo 1, OLX 4.
- Allegro można ustawić na 1-2, Ceneo na 1-3, OLX na 1-6 workerów. Zmiana obowiązuje przy kolejnym starcie lub wznowieniu.
- Przy każdym serwisie widać teraz `Aktywne: X / limit: Y`.
- Ceneo zostało spowolnione: minimum ok. 1,8 s między requestami i dodatkowa przerwa co 25 żądań. Ma domyślnie tylko 1 workera.
- Allegro zachowuje konserwatywne tempo z v1.7: domyślnie 1 worker, minimum ok. 3,2 s między requestami i dłuższa przerwa co 20 żądań.
- OLX pozostaje szybszy i może wykorzystywać wolną pulę do ustawionego limitu.
- Historia Allegro i Ceneo jest zapisywana po każdym poprawnym rekordzie. OLX zapisuje ją partiami po 5 rekordów.
- Przy każdym serwisie widać liczbę rekordów historii oraz jej faktyczny rozmiar w `chrome.storage.local`.
- Dodano `Eksport historii` dla Allegro, Ceneo i OLX oraz `Eksportuj wszystkie historie`.
- Eksport historii tworzy aktualny plik JSON, który można później ponownie zaimportować.
- Pliki znajdujące się w folderze rozszerzenia są statyczne i nigdy nie są automatycznie nadpisywane przez Chrome. Aktualna historia żyje w `chrome.storage.local`.
- `Wznów` używa aktualnych ustawień workerów z popupu, więc możesz zmienić limit przed wznowieniem zadania.
- Nadal działa cache skanu na 6 godzin, częściowe wyniki i zatrzymanie po pierwszej stronie ochronnej/403/429.

## Instalacja / aktualizacja

1. Rozpakuj ZIP.
2. Podmień pliki w tym samym folderze, którego używa obecne rozszerzenie.
3. Wejdź do `chrome://extensions`.
4. Kliknij `Odśwież` przy rozszerzeniu.

Nie usuwaj starego wpisu rozszerzenia, jeśli chcesz zachować `chrome.storage.local` z historią.

## Jak działa historia

Do historii trafia tylko pozycja, której szczegóły zostały poprawnie pobrane i sparsowane.

- `OK` zwiększa historię.
- `Błąd` nie trafia do historii i będzie próbowany ponownie.
- Allegro i Ceneo zapisują historię po każdym poprawnym rekordzie, OLX partiami po 5 rekordów.
- `Wznów` zawsze pomija już poprawnie zapisane ID.
- Zwykłe nowe uruchomienie respektuje checkbox `Pomiń wcześniej poprawnie wyeksportowane pozycje`.
- Licznik i rozmiar historii widoczny w popupie pokazują faktyczny stan `chrome.storage.local`.
- Jeśli chcesz plik na dysku, użyj przycisku `Eksport historii`. Plik w folderze rozszerzenia nie jest magazynem live i nie będzie sam zmieniał rozmiaru.

W v1.6 błąd parsera `findProductJsonLd is not defined` powodował `OK = 0`, dlatego takie pozycje nie zostały zapisane jako sprawdzone. To było celowe zabezpieczenie przed zapisaniem niepełnych danych jako poprawnych.

## Cache skanu i wznowienie

Po pełnym znalezieniu listy ofert/produktów/ogłoszeń lista jest zapisywana na 6 godzin.

Jeśli później użyjesz `Wznów`:

1. rozszerzenie sprawdza cache dla tego samego URL,
2. odczytuje aktualną historię poprawnych ID,
3. buduje kolejkę tylko z brakujących pozycji,
4. nie musi ponownie przechodzić przez wszystkie strony listingu i grupy Allegro.

Przycisk zwykłego startu robi świeży skan, aby wykryć nowe oferty.

## Limity

Przy domyślnym globalnym limicie 6:

- Allegro: 1 worker, regulacja 1-2, minimum ok. 3,2 s między requestami,
- Ceneo: 1 worker, regulacja 1-3, minimum ok. 1,8 s między requestami i przerwa co 25 żądań,
- OLX: 4 workery, regulacja 1-6.

Globalna pula jest współdzielona, ale żaden serwis nie przekroczy własnego limitu. Zwiększanie Allegro i Ceneo może szybciej uruchomić ochronę serwisu, dlatego domyślne wartości są celowo niskie.

## Ochrona serwisów

Jeśli serwis zwróci 403/429 albo stronę ochronną, zadanie tego serwisu przechodzi w stan `Wstrzymano przez ochronę serwisu`.

Rozszerzenie nie próbuje obchodzić blokady ani automatycznie bombardować strony kolejnymi requestami. Po ustaniu blokady użyj `Wznów`.

## Allegro

Allegro grupuje wiele ofert sprzedawców w kartę produktu. Eksporter najpierw zbiera karty produktów, następnie dla każdej znalezionej karty otwiera odpowiadającą stronę `/oferty-produktu/...` i zbiera indywidualne ID ofert.

W v1.7 lista grup jest budowana wyłącznie z kart produktów znalezionych na głównym listingu. Dzięki temu moduły rekomendacji i inne poboczne linki nie generują setek niepotrzebnych requestów.

## Ceneo

Ceneo może zwracać stronę ochronną przy dużej liczbie requestów. W v1.7 pierwsza taka odpowiedź zatrzymuje tylko Ceneo i zachowuje postęp. Ceneo nie blokuje dalszej pracy OLX.

## OLX

Każde ogłoszenie ma własne ID. Po naprawie parsera szczegóły obejmują m.in. tytuł, cenę, stan, parametry i opis, w którym często znajdują się dane SMART, liczba godzin i informacje o bad sectorach.


## Ceneo - tryb normalnej karty Chrome

Od v1.9 Ceneo nie jest pobierane przez surowy `fetch()` z dokumentu offscreen. Eksporter tworzy jedną nieaktywną kartę Ceneo, ładuje kolejne adresy jak zwykła przeglądarka, czeka na JavaScript strony i dopiero wtedy odczytuje HTML. Karta jest ponownie tworzona, jeśli użytkownik przypadkiem ją zamknie, a po zakończeniu zadania jest zamykana.

Ceneo ma stały limit 1 workera. To nie jest mechanizm obchodzenia ochrony serwisu: jeśli normalna karta Ceneo pokaże stronę ochronną, eksport nadal natychmiast się zatrzyma.
