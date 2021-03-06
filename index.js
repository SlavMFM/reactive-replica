
/** Position within server-side DOM hierarchy.
TODO: implement more processing efficient (i.e. less memory efficient) approach with static (growing-only) model without dynamic allocation.
*/
export default class Place
{
    /** JS-native server-side value which was last replicated to this place of client-side.*/
    replica = undefined
    
    constructor(
        name,
        replica
    )
    {
        this.name = name
        this.replica = replica
    }
    
    /** Handle server-side data.*/
    replicate(
        value
    )
    {
        postpone(
            this,
            {
                type : REPLICATE,
                value : value
            }
        )
    }
    
    /** Get child of this Place under specified path. Name is right within the path. Create all the intermediate places.*/
    resolve( path )
    {
        //undefined or else if just current place:
        if ( typeof path !== 'string' )
        {
            return this
        }
        
        var place = this
        const actualPath = path.split( '.' )
        for ( var i = 0; i < actualPath.length; ++ i )
        {
            const placeName = actualPath[ i ]
            
            //looking for specified place:
            let specified = undefined
            for ( let candidate of this.children )
            {
                if ( candidate.name === placeName )
                {
                    specified = candidate
                    break
                }
            }
            
            if ( specified )
            {
                place = specified
            }
            //creating the intermediate one:
            else
            {
                let parent = place
                place = new Place( placeName )
                parent.children.push( place )
                
                //appended place isn't user defined so no point replicating it just pass already any existing value:
                place.replica = parent.replica === undefined ? undefined : parent.replica[ place.name ]
            }
        }
        return place
    }
    
    /** Add event listener of specified type to current place.*/
    listen(
        listener,
        path
    )
    {
        postpone(
            this,
            {
                type : LISTEN,
                listener : listener,
                path : path
            }
        )
    }
    
    /** Stop listening on specified event.*/
    forget(
        listener,
        path
    )
    {
        postpone(
            this,
            {
                type : FORGET,
                listener : listener,
                path : path
            }
        )
    }
    
    /** Remove from it's parent. Children and listeners remain untouched.*/
    remove(
        place,
        path
    )
    {
        postpone(
            this,
            {
                type : REMOVE,
                removing : place,
                path : path
            }
        )
    }
    
    /** Add another model element as a child to this one or fill intermediate places.
    @param path What intermediate places to create and pass. When omitted is the same as empty string. Intermediate places are separated with dot.
    */
    append(
        place,
        path
    )
    {
        postpone(
            this,
            {
                type : APPEND,
                place : place,
                path : path
            }
        )
    }
    
    /** Creates Rx.Observable as if it is a listener to all the events: create, change and remove.
    TODO: redesign the whole Place so that notifications are not based on Listeners, but directly on Observables.
    */
    from(
        path
    )
    {
        let result = new Rx.ReplaySubject( 1 )
        this.listen(
            {
                create : true,
                change : function( after, before )
                {
                    result.next( after )
                },
                remove : function()
                {
                    result.next( undefined )
                }
            },
            path
        )
        return result
    }
    
    /** Server-side model's name.*/
    name = undefined
    /** Fields.*/
    children = []
    
    /** What will be notified when this place will be .*/
    listeners = []
    
    /** True while model is being replicated and so currently propagating events. Any client-side modifications (through append(), remove() ...) will be postponed until replication finished.*/
    busy = false
    
    /** Everything what may modify replica's structure so has to be postponed until model isn't busy to avoid race conditions.
    { type, path, ... }
    */
    postponedCommands = []
    
    /** Last removed value stored to replicate to appending REMOVE listeners.*/
    removedReplica = undefined
}

//TODO: invoke target function directly to avoid intermediate objects creation if place is not busy
function postpone( place, command )
{
    place.postponedCommands.push( command )
    
    if ( ! place.busy )
    {
        handlePostpones( place )
    }
}
    
function append(
    place,
    appending,
    path
)
{
    place = place.resolve( path )
    place.children.push( appending )
    
    appending.replicate( place.replica === undefined ? undefined : place.replica[ appending.name ] )
}

function remove(
    place,
    removing,
    path
)
{
    place = place.resolve( path )
    
    const index = place.children.indexOf( removing )
    if ( index < 0 )
    {
        console.error( 'Model: remove(): not enlisted within parent\'s children' )
        return
    }
    //using replacement instead of removement to make it faster:
    place.children[ index ] = place.children[ place.children.length - 1 ]
    place.children.pop()
}

function listen(
    place,
    listener,
    path
)
{
    place = place.resolve( path )
    place.listeners.push( listener )
    
    //... and for absent replica as well since application supposed to replicate the present model's shape:
    if ( place.replica === undefined )
    {
        issueRemove( listener, place, place.removedReplica )
    }
    //handle already existing replica:
    else
    {
        issueCreate( listener, place, place.replica )
    }
}

function forget(
    place,
    listener,
    path
)
{
    place = place.resolve( path )
    
    const before = place.listeners.length
    
    place.listeners = place.listeners.filter( function( item )
    {
        return item !== listener
    } )
}

function replicate(
    place,
    value
)
{
    place.busy = true
    
    //handle REMOVE:
    if ( value === undefined )
    {
        if ( place.replica !== undefined )
        {
            place.removedReplica = place.replica
            delete place.replica
            onRemove( place, place.removedReplica )
            
            for ( var i = 0; i < place.children.length; ++ i )
            {
                var child = place.children[ i ]
                child.replicate( undefined )
            }
        }
    }
    //handle CREATE/CHANGE:
    else
    {
        let old = place.replica
        place.replica = value
        
        if ( old === undefined )
        {
            onCreate( place, value )
        }
        //okey, let application choose what change is, since arrays are also objects:
        /*//equality determination policy for objects wasn't established yet, but let's put responsibility to handle object's changes to nested Places:
        //be careful with null values (since those are 'object's) - don't let them sneak into model and/or server-side:
        else if ( typeof value !== 'object' || typeof old !== 'object' )
        {
            if ( value !== old )
            {
                onChange( place, value, old )
            }
        }
        //otherwise both are objects - won't change ...*/
        else if ( value != old )
        {
            onChange( place, value, old )
        }
        
        //we don't care about model's fields which has no attached Places against them:
        for ( let child of place.children )
        {
            //I suppose we shouldn't care if replicating value isn't of Object type since [] operator should just return undefined (is what we need) in that case:
            child.replicate( value[ child.name ] )
        }
    }
    
    place.busy = false
}

function handlePostpones( place )
{
    for ( var i = 0; i < place.postponedCommands.length; ++ i )
    {
        var command = place.postponedCommands[ i ]
        switch ( command.type )
        {
            case LISTEN:
                listen( place, command.listener, command.path )
                break
            
            case FORGET:
                forget( place, command.listener, command.path )
                break
            
            case REMOVE:
                remove( place, command.removing, command.path )
                break
            
            case APPEND:
                append( place, command.place, command.path )
                break
            
            case REPLICATE:
                replicate( place, command.value )
                break
            
            default:
                throw 'Replica.handlePostpones(): undefined command type.'
        }
    }
    place.postponedCommands.length = 0
}

function issueCreate( listener, place, created )
{
    if ( listener.create === true )
    {
        if ( isFunction( listener.change ) )
        {
            listener.change( created, undefined, place )
        }
    }
    else if ( isFunction( listener.create ) )
    {
        listener.create( created, place )
    }
}

function onCreate( place, created )
{
    for ( let listener of place.listeners )
    {
        issueCreate( listener, place, created )
    }
}

function onChange( place, after, before )
{
    for ( let listener of place.listeners )
    {
        if ( listener.change === true )
        {
            if ( isFunction( listener.create ) )
            {
                listener.create( after, place )
            }
        }
        else if ( isFunction( listener.change ) )
        {
            listener.change( after, before, place )
        }
    }
}

function issueRemove( listener, place, old )
{
    if ( isFunction( listener.remove ) )
    {
        listener.remove( old, place )
    }
}

function onRemove( place, old )
{
    for ( let listener of place.listeners )
    {
        issueRemove( listener, place, old )
    }
}

const LISTEN = 1
const FORGET = 2
const REMOVE = 3
const APPEND = 4
const REPLICATE = 5

/** From underscore.js.*/
function isFunction( obj )
{
    return !!(obj && obj.constructor && obj.call && obj.apply)
}




