/**
 * @module src/models
 * @author Kaiying Shan, Hanzhi Zhou
 */

/**
 *
 */
import { NotiMsg } from '@/store/notification';
import { TYPES, enableKeyConversion, keyRegex } from '../config';
import * as Utils from '../utils';
import Event from './Event';
import Schedule, { ScheduleAll, ScheduleJSON, SectionJSON } from './Schedule';
import Section from './Section';
import { DAYS } from './constants';

/**
 * check whether the array is the correct JSON format for plannable v5.x to v7.x
 * @param arr
 */
// eslint-disable-next-line
function is_v5_v7(arr: any[]): arr is SectionJSON[] {
    return typeof arr[0] === 'object' && typeof arr[0].id === 'number';
}
/**
 * check whether the array is the correct JSON format for plannable v8.x
 * @param arr
 */
// eslint-disable-next-line
function is_v8(arr: any[]): arr is SectionJSON[][] {
    return arr[0] instanceof Array && is_v5_v7(arr[0]);
}

function filterSections(
    group: SectionJSON[],
    allSections: Section[],
    warnings: string[],
    convKey: string
) {
    const set = new Set<number>();
    for (const record of group) {
        // check whether the identifier of stored sections match with the existing sections
        const target =
            typeof record.section === 'undefined' // "section" property may not be recorded
                ? allSections.find(sec => sec.id === record.id) // in that case we only compare id
                : allSections.find(sec => sec.id === record.id && sec.section === record.section);
        if (target) set.add(target.id);
        // if not exist, it possibly means that section is removed from SIS
        else
            warnings.push(
                `Section ${record.section} of ${convKey} does not exist anymore! It probably has been removed!`
            );
    }
    return set;
}

export default class ProposedSchedule extends Schedule {
    constructor(raw: ScheduleAll = {}, events: Event[] = []) {
        super(raw, events);
    }

    /**
     * Update a section in the schedule
     * - If the section is **already in** the schedule, delete it from the schedule
     * - If the section is **not** in the schedule, add it to the schedule
     * @param remove whether to remove the key if the set of sections is empty
     * @param update whether to recompute the schedule after update
     */
    public update(key: string, section: number, groupIdx = 0, remove = true, update = true) {
        if (section === -1) {
            if (this.All[key] === -1) {
                if (remove) delete this.All[key];
                // empty set if remove is false
                else this.All[key] = [];
            } else {
                this.All[key] = -1;
            }
        } else {
            let sections = this.All[key];
            if (sections instanceof Array) {
                const prev = sections.find(g => g.has(section));
                if (groupIdx < 0) groupIdx = 0;
                const group = sections[groupIdx] || new Set();
                if (prev === group) {
                    // this section exists and is in the same group, remove
                    if (group.delete(section)) {
                        if (remove && this.isCourseEmpty(key)) delete this.All[key];
                    } else {
                        group.add(section);
                    }
                } else if (prev === undefined) {
                    // does not exists previously, so just add
                    group.add(section);
                } else {
                    // remove previous and add current
                    prev.delete(section);
                    group.add(section);
                }
                sections[groupIdx] = group;
            } else {
                // this is a new key
                this.All[key] = sections = [new Set<number>().add(section)];
            }
            // remove trailing empty groups
            for (let i = sections.length - 1; i >= 0 && sections[i].size === 0; i--) sections.pop();

            // fill in empty values
            for (let i = 0; i < sections.length; i++) {
                if (!(sections[i] instanceof Set)) {
                    sections[i] = new Set();
                }
            }
        }
        if (update) {
            this.constructDateSeparator();
            this.computeSchedule();
        }
    }

    /**
     * add an event to this schedule
     * @throws error if an existing event conflicts with this event
     */
    public addEvent(
        days: string,
        display: boolean,
        title?: string,
        room?: string,
        description?: string
    ) {
        for (const e of this.events) {
            if (e.days === days) {
                throw new Error(
                    `Your new event's time is identical to ${e.title}. Please consider merging these two events.`
                );
            }
        }
        const ev = new Event(days, display, title, description, room);
        this.events.push(ev);
        this.computeSchedule();
        return ev;
    }

    public deleteEvent(days: string) {
        for (let i = 0; i < this.events.length; i++) {
            if (this.events[i].days === days) {
                this.events.splice(i, 1);
                break;
            }
        }
        this.computeSchedule();
    }

    /**
     * instantiate a `Schedule` object from its JSON representation.
     * the `computeSchedule` method will **not** be invoked after instantiation
     *
     * @returns NotiMsg, whose level might be one of the following
     * 1. success: a schedule is successfully parsed from the JSON object
     * 2. warn: a schedule is successfully parsed, but some of the courses/sections recorded no longer exist
     * in the catalog
     * 3. error: the object passed in is falsy
     */
    public static fromJSON(obj?: ScheduleJSON): NotiMsg<ProposedSchedule> {
        if (!obj)
            return {
                level: 'error',
                msg: 'Invalid object'
            };
        const schedule = new ProposedSchedule();
        if (obj.events)
            schedule.events = obj.events.map(x =>
                Object.freeze(x instanceof Event ? x : Object.setPrototypeOf(x, Event.prototype))
            );

        const keys = Object.keys(obj.All).map(x => x.toLowerCase());
        if (keys.length === 0)
            return {
                level: 'success',
                msg: 'Empty schedule',
                payload: schedule
            };

        const warnings: string[] = [];
        const catalog = window.catalog;
        // convert array to set
        for (const key of keys) {
            const sections = obj.All[key] as any;

            // try to find the course corresponding to the recorded key
            const course = catalog.getCourse(key);

            let convKey = key;
            // converted key to human readable form, if enabled
            if (enableKeyConversion) {
                const parts = key.match(keyRegex);
                if (parts && parts.length === 4) {
                    parts[3] = TYPES[+parts[3] as 1];
                    parts[1] = parts[1].toUpperCase();
                    convKey = parts.slice(1).join(' ');
                }
            }
            // non existent course
            if (!course) {
                warnings.push(`${convKey} does not exist anymore! It probably has been removed!`);
                continue;
            }
            // all of the existing sections
            const allSections = course.sections;
            if (sections instanceof Array) {
                if (!sections.length) {
                    schedule.All[key] = [];
                } else {
                    // backward compatibility for version prior to v5.0 (inclusive)
                    if (Utils.isNumberArray(sections)) {
                        schedule.All[key] = [
                            new Set(
                                sections
                                    .filter(sid => {
                                        // sid >= length possibly implies that section is removed from SIS
                                        if (sid >= allSections.length) {
                                            warnings.push(
                                                `Invalid section id ${sid} for ${convKey}. It probably has been removed!`
                                            );
                                        }
                                        return sid < allSections.length;
                                    })
                                    .map(idx => allSections[idx].id)
                            )
                        ];
                        // console.log('< v5 json detected');
                    } else if (is_v5_v7(sections)) {
                        schedule.All[key] = [
                            filterSections(sections, allSections, warnings, convKey)
                        ];
                        // console.log('v5-v7 json detected');
                    } else if (is_v8(sections)) {
                        schedule.All[key] = sections.map(group =>
                            filterSections(group, allSections, warnings, convKey)
                        );
                        // console.log('v8 json detected');
                    } else {
                        schedule.All[key] = [new Set()];
                    }
                }
            } else {
                schedule.All[key] = sections;
            }
        }
        if (warnings.length) {
            return {
                level: 'warn',
                payload: schedule,
                msg: warnings.join('<br>')
            };
        } else {
            return {
                level: 'success',
                payload: schedule,
                msg: 'Success'
            };
        }
    }

    /**
     * get a copy of this schedule
     */
    public copy(deepCopyEvent = true) {
        const AllCopy = this._copy();
        // note: is it desirable to deep-copy all the events?
        return new ProposedSchedule(
            AllCopy,
            deepCopyEvent ? this.events.map(e => e.copy()) : this.events
        );
    }

    /**
     * add some random event to the schedule. For testing purposes only
     */
    private randEvents(num = 20, maxDuration = 240, minDuration = 20) {
        for (let i = 0; i < num; i++) {
            let days = '';
            for (let j = 0; j < 7; j++) {
                if (Math.random() < 0.5) {
                    days += DAYS[j];
                }
            }
            if (!days) {
                i--;
                continue;
            }
            const start = Math.floor(Math.random() * (1440 - maxDuration));
            const end =
                start + minDuration + Math.floor(Math.random() * (maxDuration - minDuration));
            if (end >= 1440) continue;

            days +=
                ' ' +
                Utils.to12hr(Utils.intTo24hr(start)) +
                ' - ' +
                Utils.to12hr(Utils.intTo24hr(end));
            // no dup check
            this.events.push(new Event(days, true, 'rand ' + i));
        }
        this.computeSchedule();
        window.saveStatus();
    }

    private addAllClasses() {
        const catalog = window.catalog;
        for (const course of catalog.courses) {
            if (course.type != 'IND') {
                const secs = [
                    new Set(
                        course.sections
                            .filter(s => s.meetings.every(m => m.room.indexOf('Web-Based') === -1))
                            .map(s => s.id)
                    )
                ];
                if (secs[0].size) this.All[course.key] = secs;
            }
        }
        this.constructDateSeparator();
        this.computeSchedule();
    }

    /**
     * Remove a course (and all its sections) from the schedule
     */
    public remove(key: string) {
        delete this.All[key];
        this.constructDateSeparator();
        this.computeSchedule();
    }
}
