# Allegro + Ceneo + OLX Offer Exporter v1.7.0

Rozszerzenie Chrome zbiera oferty z Allegro, produkty z Ceneo i ogłoszenia z OLX oraz przygotowuje eksport TXT/JSON i fragmenty do wklejenia do ChatGPT.

## Najważniejsze zmiany v1.7.0

- Naprawiono błąd `findProductJsonLd is not defined`, który w v1.6 powodował, że poprawnie pobrane strony Allegro, Ceneo i OLX były oznaczane jako błędy już na etapie parsowania.
- Allegro ma teraz twardy limit 1 workera i minimum około 3,2 s pomiędzy kolejnymi żądaniami.
- Co 20 żądań Allegro dostaje dodatkową przerwę. Wolne workery nigdy nie zwiększają szybkości Allegro ponad ten limit.
- Ceneo może użyć maks. 3 workerów, a OLX maks. 4. Globalna pula nadal jest dynamicznie współdzielona.
- Po wykryciu HTTP 403/429 albo strony ochronnej dany serwis jest natychmiast wstrzymywany. Rozszerzenie nie próbuje wielokrotnie ponawiać żądań do zablokowanego serwisu.
- Wynik częściowy i poprawnie pobrane ID są zapisywane przed zatrzymaniem z powodu ochrony serwisu.
- Historia jest aktualizowana częściej, partiami po 5 poprawnych pozycjach.
- Dodano cache skanu listingu na 6 godzin. `Wznów` może użyć już znalezionej listy i przejść od razu do niepobranych szczegółów zamiast ponownie skanować wszystkie strony.
- Przy `Wznów` poprawnie pobrane pozycje są zawsze pomijane, nawet jeśli podczas pierwszego uruchomienia opcja pomijania historii była wyłączona.
- Allegro rozwija tylko grupy odpowiadające kartom produktów faktycznie znalezionym na głównym listingu. Nie skanuje już wszystkich pobocznych linków `/oferty-produktu/`, co wcześniej potrafiło sztucznie zwiększyć liczbę grup i liczbę requestów.
- Ceneo ponownie stosuje filtry także do głównych kart i odrzuca oczywiste SSD/NVMe/M.2, jeśli źródłem jest kategoria `Dyski_HDD`.
- OLX przy poprawnym pobraniu szczegółów preferuje cenę z danych strony ogłoszenia, zamiast błędnie sklejonej ceny z listingu.

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
- `Wznów` zawsze pomija już poprawnie zapisane ID.
- Zwykłe nowe uruchomienie respektuje checkbox `Pomiń wcześniej poprawnie wyeksportowane pozycje`.

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

- Allegro: maks. 1 worker, minimum ok. 3,2 s między requestami,
- Ceneo: maks. 3 workery,
- OLX: maks. 4 workery.

Jeżeli Allegro skończy, jego slot może przejąć Ceneo lub OLX. Allegro nie przyspiesza po zakończeniu innych serwisów.

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
