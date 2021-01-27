/**
 * @module src/components
 */

/**
 *
 */
import Schedule, { DAYS } from '@/models/Schedule';
import { Component, Prop } from 'vue-property-decorator';
import Store from '../store';
import { hr24toInt, to12hr } from '../utils';
import CourseBlock from './CourseBlock.vue';

/**
 * the component for rendering a schedule (with courses and events) on a grid
 * @author Kaiying Cat
 * @noInheritDoc
 */
@Component({
    components: {
        CourseBlock
    }
})
export default class GridSchedule extends Store {
    @Prop(Object) readonly currentSchedule!: Schedule;

    df = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

    get days() {
        if (this.status.isMobile) {
            return this.display.showWeekend ? DAYS : DAYS.slice(0, 5);
        } else {
            return this.display.showWeekend ? this.df : this.df.slice(0, 5);
        }
    }

    /**
     * return the block in which the earliest class starts, the 8:00 block is zero
     * return 0 if no class
     */
    get earliestBlock() {
        let earliest = 48;
        const schedule = this.currentSchedule;
        for (const blocks of schedule.days) {
            for (const course of blocks) {
                const temp = Math.floor(course.startMin / 30);
                if (temp < earliest) {
                    earliest = temp;
                }
            }
        }
        return earliest;
    }
    /**
     * return the block in which the latest class ends, the 8:00 block is zero
     */
    get latestBlock() {
        let latest = 0;
        const schedule = this.currentSchedule;
        for (const blocks of schedule.days) {
            for (const course of blocks) {
                const temp = Math.floor(course.endMin / 30);
                if (temp > latest) {
                    latest = temp;
                }
            }
        }
        return latest;
    }
    /**
     * return the block in which the schedule starts with
     */
    get absoluteEarliest() {
        return Math.min(this.earliestBlock, Math.floor(hr24toInt(this.display.earliest) / 30));
    }
    /**
     * return the block in which the schedule ends with
     */
    get absoluteLatest() {
        return Math.max(this.latestBlock, Math.floor(hr24toInt(this.display.latest) / 30));
    }

    /**
     * computes the number of rows we need
     */
    get numRow() {
        return this.absoluteLatest + 1 - this.absoluteEarliest;
    }

    get numCol() {
        return this.display.showWeekend ? 7 : 5;
    }

    get hours() {
        const time = [];
        const stdTime = [];
        const reducedTime = [];
        for (let i = this.absoluteEarliest; i <= this.absoluteLatest; i++) {
            const curTime = `${Math.floor(i / 2)}:${i % 2 ? '30' : '00'}`;
            time.push(curTime);
            stdTime.push(to12hr(curTime));
            reducedTime.push(i % 2 !== 0 ? '' : (i / 2).toString());
        }

        return window.screen.width > 450 ? (this.display.standard ? stdTime : time) : reducedTime;
    }
    get heights() {
        const heights = new Uint16Array(this.numRow + 1).fill(this.display.partialHeight);
        heights[0] = 44; // height of the title cell
        const earliest = this.absoluteEarliest;
        for (const blocks of this.currentSchedule.days) {
            for (const course of blocks) {
                const startTime = Math.floor(course.startMin / 30) + 1;
                const endTime = Math.floor(course.endMin / 30) + 1;
                for (let i = startTime; i <= endTime; i++) {
                    heights[i - earliest] = this.display.fullHeight;
                }
            }
        }

        const sumHeights = new Uint16Array(heights);
        // to prefix array
        for (let i = 1; i < sumHeights.length; i++) {
            sumHeights[i] += sumHeights[i - 1];
        }
        return {
            heights,
            sumHeights
        };
    }
    get blockStyles() {
        console.time('compute style');
        const arr: string[][] = [[], [], [], [], [], [], []];
        // cache these properties will speed uo their access
        const schedule = this.schedule.currentSchedule;
        const sumHeights = this.heights.sumHeights;
        const absoluteEarliest = this.absoluteEarliest;
        const fullHeight = this.display.fullHeight;
        for (let i = 0; i < this.numCol; i++) {
            for (const block of schedule.days[i]) {
                const { startMin, endMin, left, width, background } = block;
                const perc = 100 / this.numCol;

                const startPx =
                    sumHeights[Math.floor(startMin / 30) - absoluteEarliest] +
                    ((startMin % 30) / 30) * fullHeight;
                const endPx =
                    sumHeights[Math.floor(endMin / 30) - absoluteEarliest] +
                    ((endMin % 30) / 30) * fullHeight;
                arr[i].push(
                    `left: ${(i + left) * perc}%; width: ${width *
                        perc}%; top: ${startPx}px; height: ${endPx -
                        startPx}px; background-color: ${background}`
                );
            }
        }
        console.timeEnd('compute style');
        return arr;
    }
}
