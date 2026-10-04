export type AppLanguage = 'pl' | 'en';
export const DEFAULT_APP_LANGUAGE: AppLanguage = 'pl';
export const LANGUAGE_STORAGE_KEY = 'poker-hand-analyzer-language';
export function readStoredLanguage(value: string | null | undefined): AppLanguage { return value === 'en' ? 'en' : 'pl'; }
export function languageMismatchKey(current: AppLanguage, generated: AppLanguage): TranslationKey | null { return current === generated ? null : current === 'pl' ? 'generatedInOtherLanguagePl' : 'generatedInOtherLanguageEn'; }
type Dictionary = Record<string, string>;

const pl = {
  language: 'Język', polish: 'Polski', english: 'English', appName: 'Analizator Pokera',
  brandSubtitle: 'ANALIZATOR POKERA', game: 'Texas Hold’em', noLimit: 'bez limitu',
  demo: 'Wczytaj przykład', clearHand: 'Wyczyść rozdanie', breadcrumb: 'PANEL ANALIZY', cashGame: 'GRA CASHOWA',
  headline: 'Podejmuj decyzje świadomie.', intro: 'Wprowadź rozdanie, sprawdź liczby i podejmij własną decyzję.', live: 'ANALIZA NA ŻYWO',
  modeLabel: 'TRYB ANALIZY', modePrompt: 'Wybierz sposób analizy rozdania', mathMode: 'Analiza matematyczna', aiMode: 'Analiza AI', aiReview: 'ANALIZA AI',
  boardGapError: 'Uzupełnij wcześniejsze karty wspólne przed dodaniem kolejnych.', duplicateError: 'Każda karta może wystąpić tylko raz. Usuń duplikat, aby kontynuować.',
  dealEyebrow: '01 · ROZDANIE', enterCards: 'Wprowadź karty', hero: 'HERO', you: 'Ty', villain: 'VILLAIN', opponent: 'Rywal',
  specificHand: 'Konkretna ręka', range: 'Zakres', cardNumber: 'Karta {{number}}', selectCard: 'wybierz kartę',
  heroRangeNote: 'Wybierz zakres Hero w macierzy poniżej. Zakres Hero nie jest synchronizowany z trybem AI.',
  quickRange: 'Szybki wybór zakresu', randomTwo: 'Dowolne 2', broadway: 'Broadway', pairs: 'Pary', removeCards: 'Usuń karty',
  communityCards: 'KARTY WSPÓLNE', board: 'Board', preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River', completeCards: 'UZUPEŁNIJ KARTY',
  stakesEyebrow: '02 · STAWKI', potAndAction: 'Pula i akcja', pot: 'Pula', villainBet: 'Zakład rywala', callAmount: 'Kwota calla', valuesInBb: 'Wartości podaj w big blindach (bb).', setCallToBet: 'Ustaw call równy zakładowi',
  tableEyebrow: '03 · WIDOK STOŁU', yourHand: 'Twoje rozdanie', recalculating: 'Przeliczanie…', recalculate: '↻ Przelicz ponownie',
  seatVillain: 'RYWAL', seatHero: 'TY', cardsOnTable: 'KARTY NA STOLE', currentPot: 'PULA AKTUALNA',
  yourHolding: 'TWÓJ UKŁAD', villainHolding: 'UKŁAD RYWALA', heroRangeLabel: 'Zakres Hero', completeYourCards: 'Uzupełnij swoje karty', opponentRange: 'Zakres przeciwnika', showdownResult: 'WYNIK PRZY ODKRYTYCH KARTACH', splitPot: 'Podział puli', heroWins: 'Wygrywasz', villainWins: 'Wygrywa rywal',
  resultEyebrow: '04 · WYNIK', handAnalysis: 'Analiza rozdania', handVsHand: 'RĘKA VS RĘKA', handVsRange: 'RĘKA VS ZAKRES', rangeVsHand: 'ZAKRES VS RĘKA', rangeVsRange: 'ZAKRES VS ZAKRES', mathOnly: 'TYLKO MATEMATYKA',
  recommendation: 'REKOMENDACJA', chooseRange: 'WYBIERZ ZAKRES', completeDeal: 'UZUPEŁNIJ KARTY', completeStakes: 'UZUPEŁNIJ STAWKI', compareEquity: 'Porównanie equity z wymaganym equity', call: 'CALL', fold: 'FOLD', raise: 'RAISE', check: 'CHECK', breakEven: 'Mniej więcej na zero',
  equity: 'Equity', requiredEquity: 'Wymagane equity', callEv: 'EV calla', rangeCallEv: 'EV calla dla zakresu',
  heroWinsPercent: 'Hero wygrywa {{value}}%', villainWinsPercent: 'Villain wygrywa {{value}}%', tiesPercent: 'Remis {{value}}%',
  simulationCount: 'Liczba symulacji Monte Carlo', simulationEstimate: 'Wynik jest estymacją opartą na losowanych rozdaniach.',
  potOddsDetails: 'Pot odds i szczegóły obliczeń', expand: 'Rozwiń', requiredEquityFormula: 'Wzór na wymagane equity', callDividedByPot: 'Kwota calla ÷ pula końcowa.', potNow: 'Pula przed betem', potAfterCall: 'Pula po callu',
  rangeEvNote: 'Średnia EV zakresu według równych wag legalnych kombinacji fizycznych; pojedyncze ręce mogą mieć inne EV.',
  boardTextureAssumptions: 'Tekstura boardu i założenia', textureChanges: 'Tekstura zmieni się wraz z kolejnymi kartami wspólnymi.', boardStats: '{{suits}} kolory · {{ranks}} różnych rang.',
  supportedModes: 'Obsługiwane są cztery tryby: ręka vs ręka, ręka vs zakres, zakres vs ręka oraz zakres vs zakres. Każda fizyczna kombinacja ma równą wagę; klasy rąk nie są traktowane jako kombinacje o równej wadze.',
  exactThreshold: 'Pełne wyliczenie stosujemy do 120 000 przypadków zestawienia i runoutu; większe przestrzenie liczymy symulacją Monte Carlo.',
  mathLimitations: 'Wynik pomija dalszą akcję, rake, zachowanie rywala, pozycję i specyfikę turnieju. To matematyczna podpowiedź, nie pełna strategia.',
  matrixHeroTitle: 'Range Matrix · Hero', matrixHeroEyebrow: 'ZAKRES HERO', matrixHeroDescription: 'Wybierz klasy rąk Hero. Board i znane karty rywala blokują niemożliwe kombinacje.',
  matrixTitle: 'Range Matrix', matrixEyebrow: '05 · ZAKRES RYWALA', matrixDescription: 'Wybierz klasy rąk, które mogą znaleźć się w zakresie rywala.',
  rangeMatrixLabel: 'macierz 169 klas rąk', selectAll: 'Zaznacz wszystko', clear: 'Wyczyść', preset: 'Gotowy zakres', tight: 'Tight', standard: 'Standard', wide: 'Wide',
  pair: 'PARA', suited: 'SUITED', offsuit: 'OFFSUIT', selected: 'WYBRANE',
  matrixHelp: 'Przekątna = pary · nad przekątną = suited · pod przekątną = offsuit. Liczby pokazują dostępne kombinacje po blockerach.',
  selectedRange: 'WYBRANY ZAKRES', legalCombosAvailable: 'legalnych kombinacji z dostępnych', combinations: 'Kombinacje', selectedClasses: 'Wybrane klasy', heroEquity: 'Equity Hero', calculatingEquity: 'Obliczanie equity…',
  matrixEquityExplanation: 'Na riverze i przy zakresie, który można w pełni wyliczyć, sprawdzamy wszystkie kombinacje. Większe przestrzenie szacujemy porcjowaną symulacją Monte Carlo.',
  blockedCards: '{{count}} znanych kart blokuje niemożliwe kombinacje.', enterCardsForBlockers: 'Wprowadź karty, aby uwzględnić blockery.',
  analysisApiUnavailable: 'Analiza AI jest niedostępna. Spróbuj ponownie później.',
  aiIntroEyebrow: 'TRYB STRATEGICZNY', aiIntro: 'Opisz przebieg rozdania i kontekst stołu. Otrzymaj interpretację strategiczną oddzieloną od faktów matematycznych.',
  aiBeta: 'ANALIZA AI · BETA', handSection: 'Hand', handSectionDescription: 'Karty Hero i wspólne', villainOptional: 'VILLAIN · OPCJONALNIE', boardLabel: 'BOARD',
  aiCardHelp: 'Karty Villaina są opcjonalne. Uzupełniaj board po kolei: flop, turn, river.',
  tableSection: 'Stół', positionAndProfile: 'Pozycja i profil rywala', heroPosition: 'Pozycja Hero', villainPosition: 'Pozycja Villaina', opponentProfile: 'Profil rywala',
  profileUnknown: 'Nieznany', profileNit: 'Nit', profileTag: 'TAG — Tight Aggressive', profileLag: 'LAG — Loose Aggressive', profilePassiveFish: 'Passive Fish', profileAggressiveFish: 'Aggressive Fish', profileManiac: 'Maniac', profileCustom: 'Własny profil',
  descriptionUnknown: 'Nieznany gracz — nie mamy wystarczających informacji o jego stylu gry. Analiza nie powinna zakładać konkretnych tendencji.',
  descriptionNit: 'Bardzo tight gracz, który gra niewiele rąk i zazwyczaj wchodzi do większych pul z mocnym zakresem. Zwykle blefuje rzadziej i unika marginalnych sytuacji.',
  descriptionTag: 'Selektywny i agresywny gracz. Gra stosunkowo niewiele rąk, ale gdy wchodzi do rozdania, często przejmuje inicjatywę poprzez bety i raise’y.',
  descriptionLag: 'Gra szerokim zakresem i często wywiera presję betami oraz raise’ami. Może mieć więcej słabszych rąk i blefów niż typowy TAG.',
  descriptionPassiveFish: 'Luźny i pasywny gracz. Gra dużo rąk i często sprawdza, ale rzadziej sam betuje lub raisuje. Jego duża agresja może częściej oznaczać mocną rękę.',
  descriptionAggressiveFish: 'Luźny i agresywny gracz, który gra dużo rąk i często betuje lub raisuje. Jego szerokie, mniej uporządkowane zakresy mogą zawierać słabe ręce i blefy.',
  descriptionManiac: 'Ekstremalnie agresywny gracz. Gra bardzo szerokim zakresem i często betuje oraz raisuje, także ze słabymi rękami. Może blefować znacznie częściej niż standardowy gracz.',
  descriptionCustom: 'Własny profil rywala. Podaj dostępne statystyki, takie jak VPIP, PFR, 3Bet i AF, aby przekazać AI dokładniejszy kontekst.',
  statVpip: 'VPIP %', statPfr: 'PFR %', statThreeBet: '3Bet %', statAf: 'AF', optional: 'Opcjonalnie',
  rangesSection: 'Zakresy', actualAndStrategicRange: 'Ręka Hero i zakres strategiczny są niezależne', heroRange: 'Zakres Hero', villainRange: 'Zakres Villaina', auto: 'Auto', custom: 'Custom',
  heroAutoCopy: 'Auto — szacowany jakościowo na podstawie pozycji Hero i historii akcji', villainAutoCopy: 'Auto — szacowany jakościowo na podstawie pozycji, akcji i profilu rywala',
  noExactFrequencies: 'Nie zakładamy dokładnych częstotliwości.', selectedCombos: 'wybranych kombinacji', ofRange: 'zakresu', classesAvailable: '{{classes}} klas · {{combos}} dostępnych kombinacji ogółem',
  actualHandNotIncluded: 'Rzeczywista ręka Hero ({{hand}}) nie należy do wybranego zakresu Hero.',
  editRangeMatrix: 'Edytuj macierz zakresu', customRangeDescription: 'Wybieraj klasy startowe. Zablokowane kombinacje nie są liczone, ale wybrane klasy pozostają zaznaczone.',
  emptyCustomRange: 'Wybrany zakres Custom jest pusty albo całkowicie zablokowany.',
  handComplete: 'Brak dalszych akcji — rozdanie zakończone.', bothPlayersAllIn: 'Obaj gracze są all-in — dalsze zakłady są niemożliwe.', bettingRoundComplete: 'Runda licytacji zakończona.', roundCompleteAdvance: 'Runda licytacji zakończona. Następna akcja: {{street}}.',
  actionsSection: 'Historia akcji', actionAmountHelp: 'Kwoty betów i raise’ów oznaczają łączny wkład na danej ulicy, w bb.', addAction: '＋ Dodaj akcję',
  smallBlind: 'Small blind (bb)', bigBlind: 'Big blind (bb)', blindsAuto: 'Blindy są dodawane automatycznie na podstawie wybranych pozycji.',
  firstActionEmpty: 'Dodaj pierwszą akcję. Wpłaty blindów są już uwzględnione w puli.', street: 'Ulica', player: 'Gracz', action: 'Akcja',
  actionFold: 'Fold', actionCheck: 'Check', actionCall: 'Call', actionBet: 'Bet', actionRaise: 'Raise to', actionAllIn: 'All-in',
  calculatedCall: 'Call — wyliczona kwota', amountToBet: 'Bet (bb)', amountToRaise: 'Raise to (bb)', amountAllIn: 'All-in do (bb)', enterAmount: 'Podaj kwotę', removeAction: 'Usuń akcję',
  potAfterActions: 'Pula po dotychczasowych akcjach', decisionSection: 'Punkt decyzji', autoFromHistory: 'Automatycznie wyliczony z historii akcji · kwoty w bb',
  potBeforeVillainAction: 'Pula przed akcją Villaina', villainBetOrRaise: 'Bet / raise Villaina', villainWager: 'Zakład Villaina', amountToCall: 'Kwota do calla',
  valuesFromHistory: 'Wartości pochodzą z historii akcji i są przekazywane do analizy bez ponownego wyliczania przez AI.', decisionStreet: 'Akcja: {{street}}.', noVillainBet: 'Brak aktywnego betu Villaina do sprawdzenia.',
  engineMath: 'Matematyka z silnika', equityUnknownAuto: 'Equity vs zakres Villaina: nieznane', unknown: 'Nieznane',
  customOrKnownHand: 'Ustaw zakres Custom albo podaj karty Villaina', evRequiresEquity: 'nieznane — wymaga equity',
  analyze: 'Analizuj z AI', analyzeAgain: 'Analizuj ponownie', analyzing: 'Analizowanie rozdania…',
  aiDisclaimer: 'AI interpretuje strategię. Equity, pot odds i EV pochodzą z deterministycznego silnika pokera.',
  aiRequestTitle: 'Nie udało się przygotować analizy', retry: 'Spróbuj ponownie',
  villainCardsOptional: 'Karty rywala są opcjonalne — wybierz obie albo wyczyść wybraną.', equityCalculationError: 'Nie udało się obliczyć equity.',
  errorNotConfigured: 'Analiza AI nie jest skonfigurowana. Dodaj klucz API w konfiguracji serwera, aby ją włączyć.', errorConfiguration: 'Konfiguracja modelu AI jest niedostępna. Sprawdź ustawienia serwera.', errorBillingQuota: 'Limit użycia lub rozliczeń usługi AI został osiągnięty.',
  errorInvalidInput: 'Dane analizy są nieprawidłowe. Sprawdź wprowadzone wartości.', errorInvalidHand: 'Dane rozdania są nieprawidłowe. Sprawdź karty, zakresy, stacki i wartości SPR.', errorInvalidActions: 'Historia akcji jest niespójna. Sprawdź kolejność akcji i ich kwoty.', errorInvalidRequest: 'Nie udało się odczytać danych analizy.', errorTooLarge: 'Dane analizy są zbyt obszerne.', errorTimeout: 'Analiza trwała zbyt długo. Spróbuj ponownie.',
  errorProvider: 'Usługa AI jest chwilowo niedostępna. Spróbuj ponownie.', errorRateLimited: 'Wysłano zbyt wiele analiz AI. Poczekaj chwilę i spróbuj ponownie.', errorDailyLimitReached: 'Dzienny limit analiz AI został osiągnięty. Spróbuj ponownie po jego odnowieniu.', errorRateLimitUnavailable: 'Analiza AI jest chwilowo niedostępna. Spróbuj ponownie później.', errorMalformed: 'Usługa AI zwróciła nieczytelną analizę. Spróbuj ponownie.', errorConnection: 'Nie udało się połączyć z usługą AI. Sprawdź połączenie i spróbuj ponownie.', errorGeneric: 'Nie udało się przeanalizować rozdania. Spróbuj ponownie.',
  generatedInOtherLanguagePl: 'Ta analiza została wygenerowana po angielsku. Uruchom analizę ponownie, aby otrzymać wersję polską.',
  generatedInOtherLanguageEn: 'This analysis was generated in Polish. Run the analysis again to receive the English version.',
  reviewEyebrow: 'ANALIZA STRATEGICZNA AI', reviewTitle: 'Analiza rozdania', dataConfidence: 'Kompletność danych · {{confidence}}',
  confidenceLow: 'Niska', confidenceMedium: 'Średnia', confidenceHigh: 'Wysoka', situationSummary: 'Opis sytuacji',
  deterministicEngine: 'DETERMINISTYCZNY SILNIK POKERA', mathematicalFacts: 'Fakty matematyczne', mathFactExplanation: 'Wartości pochodzą z silnika obliczeniowego. AI ich nie ustala ani nie zmienia.',
  equityKnownHand: 'Equity vs znana ręka Villaina', equityCustomRange: 'Equity vs wybrany zakres Villaina', equityVsVillainRange: 'Equity vs zakres Villaina', unknownRangeNotDefined: 'Nieznane — zakres nie został określony',
  requiredEquityLabel: 'Wymagane equity', callEvLabel: 'EV calla', finalPot: 'Pula po callu', exactEnumeration: 'PEŁNE WYLICZENIE', monteCarloEstimate: 'ESTYMACJA MONTE CARLO', cases: 'przypadków', simulations: 'symulacji',
  autoRangeQualitative: 'Zakres Villaina w trybie Auto jest jakościowy. Ustaw własny zakres, aby obliczyć equity.', equityUnavailable: 'Equity niedostępne', callEvNeedsRange: 'EV calla wymaga zdefiniowanego zakresu Villaina.', mathVsKnownHand: 'przeciw znanej ręce Villaina', mathVsCustomRange: 'przeciw zakresowi Villaina wybranemu przez użytkownika', mathMissingCards: 'brakuje kart do obliczenia equity', mathInvalidInput: 'dane do obliczenia equity są nieprawidłowe', mathEvNeedsEquity: 'EV wymaga znanego equity', mathNoActiveCall: 'brak aktywnej kwoty do calla',
  streetByStreet: 'Analiza ulica po ulicy', noStreetActions: 'Brak akcji ulic do oceny; analiza opiera się na aktualnym punkcie rozdania.',
  rangeAnalysis: 'Analiza zakresów', heroRangeResult: 'Zakres Hero', villainRangeResult: 'Zakres Villaina', rangeInteraction: 'Relacja zakresów',
  opponentAnalysis: 'Analiza rywala i eksploatacji', aiStrategicNotSolver: 'INTERPRETACJA STRATEGICZNA AI · NIE WYNIK SOLVERA', recommendedLine: 'Rekomendowana linia', keyTakeaways: 'Najważniejsze wnioski', confidenceAndMissing: 'Pewność danych i brakujące informacje', confidenceMeaning: 'Pewność odzwierciedla kompletność danych, a nie pewność rekomendacji strategicznej.',
  cardPickerEyebrow: 'WYBÓR KARTY', cardPickerTitle: 'Wybierz kartę', usedCardsUnavailable: 'Karty użyte w rozdaniu są niedostępne.', close: 'Zamknij', clearSelectedField: 'Wyczyść wybrane pole',
  suitSpades: 'Piki', suitHearts: 'Kier', suitDiamonds: 'Karo', suitClubs: 'Trefl', faceDownCard: 'Zakryta karta',
  startingStack: 'Stack startowy', allInAction: 'All-in — pozostały stack', playerAllIn: 'Gracz jest all-in', remainingStack: 'Pozostały stack', effectiveStack: 'Efektywny stack', startingEffectiveStack: 'Początkowy efektywny stack', maximumAvailable: 'Maksymalnie dostępne', betAllIn: 'Bet all-in', raiseAllIn: 'Raise all-in', callAllIn: 'Call all-in: {{amount}} BB', facingAllIn: 'Grasz przeciw all-in', canFullCall: 'Możliwy pełny call', spr: 'SPR', streetStart: 'na początku ulicy', sprVeryLow: 'Bardzo niski SPR', sprLow: 'Niski SPR', sprMedium: 'Średni SPR', sprHigh: 'Wysoki SPR', sprHelp: 'SPR (Stack-to-Pot Ratio) to stosunek pozostałego efektywnego stacka do puli. Pokazuje, jak duże są stacki względem puli i jak łatwo cały stack może zostać zaangażowany w rozdanie.', playerHasOnly: 'Gracz ma tylko {{amount}} BB w stacku.', opponentAllInOnlyCallFold: 'Przeciwnik jest all-in — dalsze zakłady nie są możliwe.', playerAlreadyAllIn: 'Gracz jest już all-in i nie może wykonać kolejnej akcji.', invalidStartingStack: 'Stack startowy każdego gracza musi być dodatni.', targetBelowContribution: 'Kwota docelowa nie może być mniejsza od wcześniejszego wkładu na tej ulicy.',  actionErrorDuplicatePositions: 'Hero i Villain muszą mieć różne pozycje przy stole.', actionErrorBlinds: 'Blindy muszą być nieujemne, a small blind nie może być większy od big blinda.',
  actionErrorAfterFold: 'Nie można wykonać akcji po foldzie.', actionErrorStreetOrder: 'Ulice muszą występować w kolejności: preflop, flop, turn, river.',
  actionErrorCheckFacingBet: 'Check jest niemożliwy — do sprawdzenia pozostaje {{amount}} bb.', actionErrorCallWithoutBet: 'Call jest niemożliwy — nie ma betu do wyrównania.',
  actionErrorBetFacingBet: 'Przy otwartym becie wybierz Raise zamiast Bet.', actionErrorRaiseWithoutBet: 'Raise wymaga wcześniejszego betu — wybierz Bet.', actionErrorPositiveAmount: 'Podaj dodatnią kwotę w bb.', actionErrorRaiseTarget: 'Raise to musi być większy niż aktualny bet ({{amount}} bb).',
  statsErrorPfr: 'PFR nie może być wyższe niż VPIP.', statsErrorRange: '{{stat}} musi być poprawną nieujemną wartością{{limit}}.', statsErrorMax: ' (nie większą niż 100)',
  aiEquityNotKnown: 'Equity vs zakres Villaina: nieznane',
  comboTooltip: '{{hand}} · {{available}} z {{total}} dostępnych kombinacji',
  runouts: 'runoutów', rangeCases: 'przypadków zakresu',
  textureMonotone: 'Monotonne', textureTwoTone: 'Dwukolorowa', textureRainbow: 'Tęczowa', textureConnected: 'Połączony', textureUnpaired: 'Niesparowany',
  missingVillainHand: 'Karty Villaina są nieznane, a jego zakres jest szacowany.', missingHeroRange: 'Zakres Hero jest opisowy; nie podano częstotliwości kombinacji.', missingVillainRange: 'Zakres Villaina jest opisowy; nie podano częstotliwości kombinacji.', missingActions: 'Nie podano historii akcji.', missingPreflop: 'Dostępne są tylko informacje sprzed flopa; nie rozdano kart wspólnych.', missingBoard: 'Board jest niekompletny ({{count}} z 5 kart).', missingCustomStats: 'Dla profilu własnego nie podano statystyk HUD.', missingStack: 'Nie podano efektywnego stacka ani liczby rozdań dla statystyk rywala.',
} as const;

const en: { [K in keyof typeof pl]: string } = {
  language: 'Language', polish: 'Polski', english: 'English', appName: 'Poker Hand Analyzer',
  brandSubtitle: 'POKER HAND ANALYZER', game: 'Texas Hold’em', noLimit: 'no limit',
  demo: 'Load demo hand', clearHand: 'Clear hand', breadcrumb: 'ANALYSIS PANEL', cashGame: 'CASH GAME',
  headline: 'Make every decision count.', intro: 'Enter a hand, review the numbers, and make your own decision.', live: 'LIVE ANALYSIS',
  modeLabel: 'ANALYSIS MODE', modePrompt: 'Choose how to analyze the hand', mathMode: 'Mathematical Analysis', aiMode: 'AI Analysis', aiReview: 'AI REVIEW',
  boardGapError: 'Complete earlier community cards before adding later streets.', duplicateError: 'A card can only appear once. Remove the duplicate to continue.',
  dealEyebrow: '01 · HAND', enterCards: 'Enter the cards', hero: 'HERO', you: 'You', villain: 'VILLAIN', opponent: 'Opponent',
  specificHand: 'Specific hand', range: 'Range', cardNumber: 'Card {{number}}', selectCard: 'select a card',
  heroRangeNote: 'Choose Hero’s range in the matrix below. The Hero range is separate from AI mode.',
  quickRange: 'Quick range selection', randomTwo: 'Any two', broadway: 'Broadway', pairs: 'Pairs', removeCards: 'Remove cards',
  communityCards: 'COMMUNITY CARDS', board: 'Board', preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River', completeCards: 'COMPLETE THE BOARD',
  stakesEyebrow: '02 · STAKES', potAndAction: 'Pot and action', pot: 'Pot', villainBet: 'Villain bet', callAmount: 'Amount to call', valuesInBb: 'Enter amounts in big blinds (bb).', setCallToBet: 'Set call equal to bet',
  tableEyebrow: '03 · TABLE VIEW', yourHand: 'Your hand', recalculating: 'Recalculating…', recalculate: '↻ Recalculate',
  seatVillain: 'VILLAIN', seatHero: 'HERO', cardsOnTable: 'COMMUNITY CARDS', currentPot: 'CURRENT POT',
  yourHolding: 'YOUR HAND', villainHolding: 'VILLAIN HAND', heroRangeLabel: 'Hero range', completeYourCards: 'Complete your cards', opponentRange: 'Opponent range', showdownResult: 'SHOWDOWN RESULT', splitPot: 'Split pot', heroWins: 'You win', villainWins: 'Villain wins',
  resultEyebrow: '04 · RESULTS', handAnalysis: 'Hand analysis', handVsHand: 'HAND VS HAND', handVsRange: 'HAND VS RANGE', rangeVsHand: 'RANGE VS HAND', rangeVsRange: 'RANGE VS RANGE', mathOnly: 'MATHEMATICS ONLY',
  recommendation: 'RECOMMENDATION', chooseRange: 'CHOOSE A RANGE', completeDeal: 'COMPLETE THE HAND', completeStakes: 'COMPLETE THE STAKES', compareEquity: 'Equity compared with required equity', call: 'CALL', fold: 'FOLD', raise: 'RAISE', check: 'CHECK', breakEven: 'Approximately break-even',
  equity: 'Equity', requiredEquity: 'Required equity', callEv: 'Call EV', rangeCallEv: 'Range call EV',
  heroWinsPercent: 'Hero wins {{value}}%', villainWinsPercent: 'Villain wins {{value}}%', tiesPercent: 'Ties {{value}}%',
  simulationCount: 'Monte Carlo simulation count', simulationEstimate: 'This result is an estimate based on sampled hands.',
  potOddsDetails: 'Pot odds and calculation details', expand: 'Expand', requiredEquityFormula: 'Required equity formula', callDividedByPot: 'Call amount ÷ final pot.', potNow: 'Pot before bet', potAfterCall: 'Pot after call',
  rangeEvNote: 'Average range EV weights each legal physical combination equally; individual hands can have different EVs.',
  boardTextureAssumptions: 'Board texture and assumptions', textureChanges: 'The texture will update as community cards are dealt.', boardStats: '{{suits}} suits · {{ranks}} distinct ranks.',
  supportedModes: 'All four matchups are supported: hand vs hand, hand vs range, range vs hand, and range vs range. Each physical combination is weighted equally; hand classes are not treated as equally weighted combinations.',
  exactThreshold: 'All cases are enumerated up to 120,000 matchup/runout cases; larger spaces use Monte Carlo simulation.',
  mathLimitations: 'This result excludes future action, rake, opponent behavior, position, and tournament context. It is a mathematical reference, not a complete strategy.',
  matrixHeroTitle: 'Range Matrix · Hero', matrixHeroEyebrow: 'HERO RANGE', matrixHeroDescription: 'Choose Hero hand classes. The board and known Villain cards block impossible combinations.',
  matrixTitle: 'Range Matrix', matrixEyebrow: '05 · VILLAIN RANGE', matrixDescription: 'Choose the hand classes that may be in Villain’s range.',
  rangeMatrixLabel: 'matrix of 169 hand classes', selectAll: 'Select all', clear: 'Clear', preset: 'Preset range', tight: 'Tight', standard: 'Standard', wide: 'Wide',
  pair: 'PAIR', suited: 'SUITED', offsuit: 'OFFSUIT', selected: 'SELECTED',
  matrixHelp: 'Diagonal = pairs · above diagonal = suited · below diagonal = offsuit. Counts show combinations available after blockers.',
  selectedRange: 'SELECTED RANGE', legalCombosAvailable: 'of available legal combinations', combinations: 'Combinations', selectedClasses: 'Selected classes', heroEquity: 'Hero equity', calculatingEquity: 'Calculating equity…',
  matrixEquityExplanation: 'On the river, and whenever a range can be fully enumerated, every combination is evaluated. Larger spaces use chunked Monte Carlo simulation.',
  blockedCards: '{{count}} known cards block impossible combinations.', enterCardsForBlockers: 'Enter cards to apply blockers.',
  analysisApiUnavailable: 'AI analysis is unavailable. Please try again later.',
  aiIntroEyebrow: 'STRATEGIC MODE', aiIntro: 'Describe the hand and table context for a strategic interpretation with mathematical facts kept separate.',
  aiBeta: 'AI REVIEW · BETA', handSection: 'Hand', handSectionDescription: 'Hero and community cards', villainOptional: 'VILLAIN · OPTIONAL', boardLabel: 'BOARD',
  aiCardHelp: 'Villain cards are optional. Complete the board in order: flop, turn, river.',
  tableSection: 'Table', positionAndProfile: 'Position and opponent profile', heroPosition: 'Hero position', villainPosition: 'Villain position', opponentProfile: 'Opponent profile',
  profileUnknown: 'Unknown', profileNit: 'Nit', profileTag: 'TAG — Tight Aggressive', profileLag: 'LAG — Loose Aggressive', profilePassiveFish: 'Passive Fish', profileAggressiveFish: 'Aggressive Fish', profileManiac: 'Maniac', profileCustom: 'Custom profile',
  descriptionUnknown: 'Unknown player — there is not enough information about their style. The analysis should not assume specific tendencies.',
  descriptionNit: 'A very tight player who plays few hands and usually enters larger pots with a strong range. They bluff less often and avoid marginal spots.',
  descriptionTag: 'A selective, aggressive player. They play relatively few hands, but often take the initiative by betting and raising when they enter a pot.',
  descriptionLag: 'Plays a wide range and often applies pressure with bets and raises. They may have more weak hands and bluffs than a typical TAG.',
  descriptionPassiveFish: 'A loose, passive player. They play many hands and often call, but bet or raise less often. A burst of aggression may more often indicate a strong hand.',
  descriptionAggressiveFish: 'A loose, aggressive player who plays many hands and often bets or raises. Their broad, less structured ranges can contain weak hands and bluffs.',
  descriptionManiac: 'An extremely aggressive player. They play a very wide range and often bet and raise, including with weak hands. They may bluff much more often than a typical player.',
  descriptionCustom: 'A custom opponent profile. Enter available stats such as VPIP, PFR, 3Bet, and AF to give the AI more context.',
  statVpip: 'VPIP %', statPfr: 'PFR %', statThreeBet: '3Bet %', statAf: 'AF', optional: 'Optional',
  rangesSection: 'Ranges', actualAndStrategicRange: 'Hero’s actual hand and strategic range are separate', heroRange: 'Hero range', villainRange: 'Villain range', auto: 'Auto', custom: 'Custom',
  heroAutoCopy: 'Auto — qualitative estimate from Hero position and action history', villainAutoCopy: 'Auto — qualitative estimate from position, actions, and opponent profile',
  noExactFrequencies: 'No exact frequencies are assumed.', selectedCombos: 'selected combinations', ofRange: 'of range', classesAvailable: '{{classes}} classes · {{combos}} available combinations total',
  actualHandNotIncluded: 'Hero’s actual hand ({{hand}}) is not included in the selected Hero range.',
  editRangeMatrix: 'Edit range matrix', customRangeDescription: 'Choose starting-hand classes. Blocked combinations are excluded from counts, while selected classes remain selected.',
  emptyCustomRange: 'The selected Custom range is empty or fully blocked.',
  handComplete: 'No further actions — hand is complete.', bothPlayersAllIn: 'Both players are all-in — no further betting is possible.', bettingRoundComplete: 'Betting round complete.', roundCompleteAdvance: 'Betting round complete. Next action: {{street}}.',
  actionsSection: 'Action history', actionAmountHelp: 'Bet and raise amounts are total contributions on that street, in bb.', addAction: '＋ Add action',
  smallBlind: 'Small blind (bb)', bigBlind: 'Big blind (bb)', blindsAuto: 'Blinds are added automatically based on the selected positions.',
  firstActionEmpty: 'Add the first action. Blind contributions are already included in the pot.', street: 'Street', player: 'Player', action: 'Action',
  actionFold: 'Fold', actionCheck: 'Check', actionCall: 'Call', actionBet: 'Bet', actionRaise: 'Raise to', actionAllIn: 'All-in',
  calculatedCall: 'Call — calculated amount', amountToBet: 'Bet (bb)', amountToRaise: 'Raise to (bb)', amountAllIn: 'All-in to (bb)', enterAmount: 'Enter amount', removeAction: 'Remove action',
  potAfterActions: 'Pot after actions so far', decisionSection: 'Decision point', autoFromHistory: 'Calculated automatically from action history · amounts in bb',
  potBeforeVillainAction: 'Pot before Villain action', villainBetOrRaise: 'Villain bet / raise', villainWager: 'Villain bet', amountToCall: 'Amount to call',
  valuesFromHistory: 'These values come from the action history and are passed to the analysis without recalculation by AI.', decisionStreet: 'Action: {{street}}.', noVillainBet: 'There is no active Villain bet to call.',
  engineMath: 'Engine calculations', equityUnknownAuto: 'Equity vs Villain range: unknown', unknown: 'Unknown',
  customOrKnownHand: 'Set a Custom range or enter Villain’s cards', evRequiresEquity: 'unknown — requires equity',
  analyze: 'Analyze with AI', analyzeAgain: 'Analyze again', analyzing: 'Analyzing hand…',
  aiDisclaimer: 'AI interprets strategy. Equity, pot odds, and EV come from the deterministic poker engine.',
  aiRequestTitle: 'Could not prepare the analysis', retry: 'Try again',
  villainCardsOptional: 'Villain cards are optional — choose both or clear the selected one.', equityCalculationError: 'Could not calculate equity.',
  errorNotConfigured: 'AI analysis is not configured. Add an API key to the server configuration to enable it.', errorConfiguration: 'AI model configuration is unavailable. Check the server settings.', errorBillingQuota: 'The AI service usage or billing limit was reached.',
  errorInvalidInput: 'The analysis data is invalid. Check the supplied values.', errorInvalidHand: 'The hand data is invalid. Check the cards, ranges, stacks, and SPR values.', errorInvalidActions: 'The action history is inconsistent. Check the action order and amounts.', errorInvalidRequest: 'Could not read the analysis request.', errorTooLarge: 'The analysis data is too large.', errorTimeout: 'The analysis took too long. Please try again.',
  errorProvider: 'The AI service is temporarily unavailable. Please try again.', errorRateLimited: 'Too many AI analyses were requested. Wait a moment and try again.', errorDailyLimitReached: 'The daily AI analysis limit has been reached. Please try again after it resets.', errorRateLimitUnavailable: 'AI analysis is temporarily unavailable. Please try again later.', errorMalformed: 'The AI service returned an unreadable analysis. Please try again.', errorConnection: 'Could not connect to the AI service. Check your connection and try again.', errorGeneric: 'Could not analyze the hand. Please try again.',
  generatedInOtherLanguagePl: 'Ta analiza została wygenerowana po angielsku. Uruchom analizę ponownie, aby otrzymać wersję polską.',
  generatedInOtherLanguageEn: 'This analysis was generated in Polish. Run the analysis again to receive the English version.',
  reviewEyebrow: 'AI STRATEGIC ANALYSIS', reviewTitle: 'AI Hand Review', dataConfidence: 'Data completeness · {{confidence}}',
  confidenceLow: 'Low', confidenceMedium: 'Medium', confidenceHigh: 'High', situationSummary: 'Situation summary',
  deterministicEngine: 'DETERMINISTIC POKER ENGINE', mathematicalFacts: 'Mathematical facts', mathFactExplanation: 'These values come from the calculation engine. AI does not determine or change them.',
  equityKnownHand: 'Equity vs known Villain hand', equityCustomRange: 'Equity vs selected Villain range', equityVsVillainRange: 'Equity vs Villain range', unknownRangeNotDefined: 'Unknown — range not defined',
  requiredEquityLabel: 'Required equity', callEvLabel: 'Call EV', finalPot: 'Final pot after call', exactEnumeration: 'EXACT ENUMERATION', monteCarloEstimate: 'MONTE CARLO ESTIMATE', cases: 'cases', simulations: 'simulations',
  autoRangeQualitative: 'Villain’s Auto range is qualitative. Set a Custom range to calculate equity.', equityUnavailable: 'Equity unavailable', callEvNeedsRange: 'Call EV requires a defined Villain range.', mathVsKnownHand: 'vs a known Villain hand', mathVsCustomRange: 'vs the user-selected Villain range', mathMissingCards: 'cards required to calculate equity are missing', mathInvalidInput: 'the equity calculation input is invalid', mathEvNeedsEquity: 'EV requires known equity', mathNoActiveCall: 'there is no active call amount',
  streetByStreet: 'Street-by-street analysis', noStreetActions: 'No street actions to review; the analysis is based on the current decision point.',
  rangeAnalysis: 'Range analysis', heroRangeResult: 'Hero range', villainRangeResult: 'Villain range', rangeInteraction: 'Range interaction',
  opponentAnalysis: 'Opponent / exploitative analysis', aiStrategicNotSolver: 'AI STRATEGIC INTERPRETATION · NOT A SOLVER RESULT', recommendedLine: 'Recommended line', keyTakeaways: 'Key takeaways', confidenceAndMissing: 'Confidence and missing information', confidenceMeaning: 'Confidence reflects input completeness, not certainty of the strategic recommendation.',
  cardPickerEyebrow: 'CARD SELECTION', cardPickerTitle: 'Choose a card', usedCardsUnavailable: 'Cards already in the hand are unavailable.', close: 'Close', clearSelectedField: 'Clear selected slot',
  suitSpades: 'Spades', suitHearts: 'Hearts', suitDiamonds: 'Diamonds', suitClubs: 'Clubs', faceDownCard: 'Face-down card',
  startingStack: 'Starting stack', allInAction: 'All-in — full remaining stack', playerAllIn: 'Player is all-in', remainingStack: 'Remaining stack', effectiveStack: 'Effective stack', startingEffectiveStack: 'Starting effective stack', maximumAvailable: 'Maximum available', betAllIn: 'Bet all-in', raiseAllIn: 'Raise all-in', callAllIn: 'All-in call: {{amount}} BB', facingAllIn: 'Facing an all-in', canFullCall: 'Full call available', spr: 'SPR', streetStart: 'at street start', sprVeryLow: 'Very low SPR', sprLow: 'Low SPR', sprMedium: 'Medium SPR', sprHigh: 'High SPR', sprHelp: 'SPR (Stack-to-Pot Ratio) is the ratio of the remaining effective stack to the pot. It shows how deep the players are relative to the pot and how easily the entire stack can become committed.', playerHasOnly: 'Player has only {{amount}} BB remaining.', opponentAllInOnlyCallFold: 'Opponent is all-in — only call or fold is available.', playerAlreadyAllIn: 'Player is already all-in and cannot act again.', invalidStartingStack: 'Each player must have a positive starting stack.', targetBelowContribution: 'The target cannot be below the player’s previous contribution on this street.', actionErrorDuplicatePositions: 'Hero and Villain must have different table positions.', actionErrorBlinds: 'Blinds must be non-negative, and the small blind cannot exceed the big blind.',
  actionErrorAfterFold: 'No action can be taken after a fold.', actionErrorStreetOrder: 'Streets must be ordered preflop, flop, turn, river.',
  actionErrorCheckFacingBet: 'Check is not possible — {{amount}} bb remains to call.', actionErrorCallWithoutBet: 'Call is not possible — there is no bet to match.',
  actionErrorBetFacingBet: 'Choose Raise instead of Bet when facing a bet.', actionErrorRaiseWithoutBet: 'Raise requires a previous bet — choose Bet.', actionErrorPositiveAmount: 'Enter a positive amount in bb.', actionErrorRaiseTarget: 'Raise to must exceed the current bet ({{amount}} bb).',
  statsErrorPfr: 'PFR cannot exceed VPIP.', statsErrorRange: '{{stat}} must be a valid non-negative value{{limit}}.', statsErrorMax: ' (no greater than 100)',
  aiEquityNotKnown: 'Equity vs Villain range: unknown',
  comboTooltip: '{{hand}} · {{available}} of {{total}} combinations available',
  runouts: 'runouts', rangeCases: 'range cases',
  textureMonotone: 'Monotone', textureTwoTone: 'Two-tone', textureRainbow: 'Rainbow', textureConnected: 'Connected', textureUnpaired: 'Unpaired',
  missingVillainHand: 'Villain cards are unknown and the range is estimated.', missingHeroRange: 'Hero range is qualitative; combo frequencies were not supplied.', missingVillainRange: 'Villain range is qualitative; combo frequencies were not supplied.', missingActions: 'No action history was supplied.', missingPreflop: 'Only preflop information is available; no board cards were dealt.', missingBoard: 'Board is incomplete ({{count}} of 5 cards).', missingCustomStats: 'Custom opponent profile has no HUD statistics.', missingStack: 'Effective stack depth and opponent-stat sample sizes were not supplied.',
};

export type TranslationKey = keyof typeof pl;
export const dictionaries: Record<AppLanguage, Record<TranslationKey, string>> = { pl, en };
export function translate(language: AppLanguage, key: TranslationKey, values: Record<string, string | number> = {}): string {
  return dictionaries[language][key].replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values[name] ?? ''));
}
export function formatNumber(language: AppLanguage, value: number, fractionDigits = 1): string {
  return new Intl.NumberFormat(language === 'pl' ? 'pl-PL' : 'en-US', { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }).format(value);
}
export function translateActionError(message: string, language: AppLanguage, t: (key: TranslationKey, values?: Record<string, string | number>) => string): string {
  const remaining = message.match(/(?:Gracz ma tylko ([\d.,]+) BB w stacku|Player has only ([\d.,]+) BB remaining)/);
  if (remaining) return t('playerHasOnly', { amount: formatNumber(language, Number((remaining[1] ?? remaining[2]).replace(',', '.')), 2).replace(/(?:,00|\.00)$/, '') });
  if (message.includes('Stack startowy każdego gracza') || message.includes('Each player must have a positive starting stack')) return t('invalidStartingStack');
  if (message.includes('Kwota docelowa nie może') || message.includes('The target cannot be below')) return t('targetBelowContribution');
  if (message.includes('Gracz jest już all-in') || message.includes('Player is already all-in')) return t('playerAlreadyAllIn');
  if (message.includes('Przeciwnik jest all-in') || message.includes('Opponent is all-in')) return t('opponentAllInOnlyCallFold');
  if (message.includes('Hero i rywal') || message.includes('Hero and Villain')) return t('actionErrorDuplicatePositions');
  if (message.includes('Blindy muszą') || message.includes('Blinds must')) return t('actionErrorBlinds');
  if (message.includes('Nie można wykonać akcji po foldzie') || message.includes('No action can be taken after a fold')) return t('actionErrorAfterFold');
  if (message.includes('Ulice muszą występować') || message.includes('Streets must be ordered')) return t('actionErrorStreetOrder');
  const check = message.match(/pozostaje ([\d.]+) bb/) ?? message.match(/([\d.]+) bb remains/);
  if (check) return t('actionErrorCheckFacingBet', { amount: formatNumber(language, Number(check[1]), 2) });
  if (message.includes('Call jest niemożliwy') || message.includes('Call is not possible')) return t('actionErrorCallWithoutBet');
  if (message.includes('Przy otwartym zakładzie') || message.includes('Choose Raise instead of Bet')) return t('actionErrorBetFacingBet');
  if (message.includes('Raise wymaga wcześniejszego') || message.includes('Raise requires a previous bet')) return t('actionErrorRaiseWithoutBet');
  if (message.includes('Podaj dodatnią kwotę') || message.includes('Enter a positive amount')) return t('actionErrorPositiveAmount');
  const raise = message.match(/\(([\d.]+) bb\)/);
  if (raise && (message.includes('Raise to musi') || message.includes('Raise to must'))) return t('actionErrorRaiseTarget', { amount: formatNumber(language, Number(raise[1]), 2) });
  return message;
}
export type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

export function translateStatsError(message: string, t: (key: TranslationKey, values?: Record<string, string | number>) => string): string {
  if (message.includes('PFR cannot be higher') || message.includes('PFR cannot exceed')) return t('statsErrorPfr');
  const match = message.match(/^(vpip|pfr|threeBet|aggressionFactor) must be a valid non-negative value( no greater than 100)?\./i);
  if (!match) return message;
  const statKey = ({vpip:'statVpip',pfr:'statPfr',threeBet:'statThreeBet',aggressionFactor:'statAf'} as const)[match[1] as 'vpip'|'pfr'|'threeBet'|'aggressionFactor'];
  return t('statsErrorRange',{stat:t(statKey),limit:match[2]?t('statsErrorMax'):''});
}

export function translateMissingInformation(message: string, language: AppLanguage, t: (key: TranslationKey, values?: Record<string, string | number>) => string): string {
  if (message.startsWith('Villain cards are unknown')) return t('missingVillainHand');
  if (message.startsWith('Hero range is qualitative')) return t('missingHeroRange');
  if (message.startsWith('Villain range is qualitative')) return t('missingVillainRange');
  if (message.startsWith('No action history')) return t('missingActions');
  if (message.startsWith('Only preflop')) return t('missingPreflop');
  const board = message.match(/Board is incomplete \(\d+ of 5 cards\)/);
  if (board) { const count = board[0].match(/\d+/)?.[0] ?? '0'; return t('missingBoard',{count:Number(count)}); }
  if (message.startsWith('Custom opponent profile')) return t('missingCustomStats');
  if (message.startsWith('Effective stack')) return t('missingStack');
  return message;
}
