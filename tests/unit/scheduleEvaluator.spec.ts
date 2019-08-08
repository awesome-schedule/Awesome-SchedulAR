import ScheduleEvaluator, { EvaluatorOptions } from '@/algorithm/ScheduleEvaluator';
import { RawAlgoSchedule } from '@/algorithm/ScheduleGenerator';
import filter from '@/store/filter';

test('dummy', () => {
    expect(1).toBe(1);
});

const d1 = new Date('2019/8/28').getTime();
const d2 = new Date('2019/12/7').getTime();

const schedules: RawAlgoSchedule = [
    ['1', [1], new Int16Array([8, 11, 11, 11, 11, 11, 11, 11, 100, 200, -1]), [d1, d2]],
    ['2', [1], new Int16Array([8, 11, 11, 11, 11, 11, 11, 11, 50, 80, -1]), [d1, d2]],
    ['3', [1], new Int16Array([8, 11, 11, 11, 11, 11, 11, 11, 350, 450, -1]), [d1, d2]],
    ['4', [1], new Int16Array([8, 11, 11, 11, 11, 11, 11, 11, 10, 15, -1]), [d1, d2]],
    [
        '5',
        [1],
        new Int16Array([8, 8, 14, 11, 11, 11, 11, 11, 500, 600, -1, 300, 350, -1]),
        [d1, d2]
    ],
    ['6', [1], new Int16Array([8, 8, 14, 11, 11, 11, 11, 11, 250, 300, -1, 100, 200, -1]), [d1, d2]]
];

const classList = Array.from({ length: 6 }, (_, i) => [schedules[i]]);
const allChoices = new Uint8Array(6);

const size = schedules.reduce((acc, x) => acc + (x[2].length - 8), 8);
const blocks = new Int16Array(size);
describe('Schedule Evaluator Test', () => {
    it('Compactness Test', () => {
        const evaluator = new ScheduleEvaluator(filter.sortOptions, window.timeMatrix);
        const b = blocks.slice();
        ScheduleEvaluator.sortBlocks(b, allChoices, classList, 6, 0);
        const func = ScheduleEvaluator.sortFunctions.compactness.bind(evaluator);
        expect(func(b)).toBe(35 + 20 + 150 + 50 + 0 + 150);
    });

    it('Insertion Test', () => {
        const b = blocks.slice();
        ScheduleEvaluator.sortBlocks(b, allChoices, classList, 6, 0);
        expect(Array.from(b.slice(8, 20))).toEqual([
            10,
            15,
            -1,
            50,
            80,
            -1,
            100,
            200,
            -1,
            350,
            450,
            -1
        ]);
        expect(Array.from(b.slice(20))).toEqual([
            100,
            200,
            -1,
            250,
            300,
            -1,
            300,
            350,
            -1,
            500,
            600,
            -1
        ]);
    });

    it('lunch Test', () => {
        expect(1).toBe(1);
    });

    it('Sort Option JSON Parse', () => {
        const rawSortOptions: EvaluatorOptions = {
            sortBy: [
                {
                    name: 'distance',
                    enabled: false,
                    reverse: true
                }
            ],
            mode: 1
        };
        const sortOption = filter.sortOptions;
        sortOption.fromJSON(rawSortOptions);
        expect(sortOption.sortBy[0].enabled).toBe(false);
        expect(sortOption.sortBy[0].reverse).toBe(true);
        expect(sortOption.mode).toBe(1);
        const optionDefaults = filter.sortOptions;
        for (let i = 1; i < sortOption.sortBy.length; i++) {
            expect(sortOption.sortBy[i]).toEqual(optionDefaults.sortBy[i]);
        }
    });
});
